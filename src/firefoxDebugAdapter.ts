import * as fs from 'fs-extra';
import { Socket } from 'net';
import { ChildProcess } from 'child_process';
import * as chokidar from 'chokidar';
import debounce = require('debounce');
import { DebugProtocol } from 'vscode-debugprotocol';
import { DebugSession, InitializedEvent, TerminatedEvent, StoppedEvent, OutputEvent, ThreadEvent, BreakpointEvent, ContinuedEvent, Thread, Variable, Breakpoint } from 'vscode-debugadapter';
import { Log } from './util/log';
import { delay, accessorExpression } from './util/misc';
import { AddonManager } from './util/addon';
import { launchFirefox, connect, waitForSocket } from './util/launcher';
import { DebugAdapterBase } from './debugAdapterBase';
import { DebugConnection, TabActorProxy, WorkerActorProxy, IThreadActorProxy, ConsoleActorProxy, ExceptionBreakpoints, ISourceActorProxy, ObjectGripActorProxy, LongStringGripActorProxy } from './firefox/index';
import { ThreadAdapter, ThreadPauseCoordinator, BreakpointInfo, SourceAdapter, FrameAdapter, VariableAdapter, VariablesProvider, ConsoleAPICallAdapter } from './adapter/index';
import { LaunchConfiguration, AttachConfiguration, parseConfiguration, ParsedConfiguration } from "./configuration";
import { PathMapper, urlDetector } from './util/pathMapper';
import { isWindowsPlatform as detectWindowsPlatform } from './util/misc';

let log = Log.create('FirefoxDebugAdapter');
let consoleActorLog = Log.create('ConsoleActor');

let isWindowsPlatform = detectWindowsPlatform();

export class FirefoxDebugAdapter extends DebugAdapterBase {

	private config: ParsedConfiguration;

	private firefoxProc?: ChildProcess;
	public firefoxDebugConnection: DebugConnection; //TODO make private again
	private firefoxDebugSocketClosed: boolean;

	public pathMapper: PathMapper;
	private addonManager: AddonManager;


	private reloadWatcher?: chokidar.FSWatcher;

	private reloadTabs = false;

	public nextTabId = 1; //TODO make private again
	private tabsById = new Map<number, TabActorProxy>();

	private nextThreadId = 1;
	private threadsById = new Map<number, ThreadAdapter>();
	private lastActiveConsoleThreadId: number = 0;

	private nextBreakpointId = 1;
	private breakpointsBySourcePath = new Map<string, BreakpointInfo[]>();
	private verifiedBreakpointSources: string[] = [];
	private threadPauseCoordinator = new ThreadPauseCoordinator();

	private nextFrameId = 1;
	private framesById = new Map<number, FrameAdapter>();

	private nextVariablesProviderId = 1;
	private variablesProvidersById = new Map<number, VariablesProvider>();

	private nextSourceId = 1;
	private sourcesById = new Map<number, SourceAdapter>();

	private exceptionBreakpoints: ExceptionBreakpoints = ExceptionBreakpoints.All;

	public constructor(debuggerLinesStartAt1: boolean, isServer: boolean = false) {
		super(debuggerLinesStartAt1, isServer);

		if (!isServer) {
			Log.consoleLog = (msg: string) => {
				this.sendEvent(new OutputEvent(msg + '\n'));
			}
		}
	}

	protected initialize(args: DebugProtocol.InitializeRequestArguments): DebugProtocol.Capabilities {
		return {
			supportsConfigurationDoneRequest: false,
			supportsEvaluateForHovers: false,
			supportsFunctionBreakpoints: false,
			supportsConditionalBreakpoints: true,
			supportsSetVariable: true,
			supportsCompletionsRequest: true,
			exceptionBreakpointFilters: [
				{
					filter: 'all',
					label: 'All Exceptions',
					default: false
				},
				{
					filter: 'uncaught',
					label: 'Uncaught Exceptions',
					default: true
				}
			]
		};
	}

	private async parseConfiguration(config: LaunchConfiguration | AttachConfiguration): Promise<void> {
		this.config = await parseConfiguration(config);
		this.pathMapper = new PathMapper(this.config.pathMappings, this.config.addon);
		if (this.config.addon) {
			this.addonManager = new AddonManager(this.config.addon, this.config.sourceMaps);
		}
	}

	protected async launch(args: LaunchConfiguration): Promise<void> {

		await this.parseConfiguration(args);

		let socket: Socket | undefined = undefined;

		if (this.config.attach) {
			try {
				socket = await connect(this.config.attach.port, this.config.attach.host);
				this.reloadTabs = this.config.attach.reloadTabs;
			} catch(err) {}
		}

		if (socket === undefined) {

			// send messages from Firefox' stdout to the debug console when debugging an addonSdk extension
			let sendToConsole: (msg: string) => void = 
				(this.config.addon && this.config.addon.type === 'addonSdk') ? 
					(msg) => this.sendEvent(new OutputEvent(msg + '\n', 'stdout')) :
					(msg) => undefined;

			this.firefoxProc = await launchFirefox(this.config.launch!, sendToConsole, this.addonManager);

			socket = await waitForSocket(args.port || 6000);
		}

		this.startSession(socket);
	}

	protected async attach(args: AttachConfiguration): Promise<void> {

		await this.parseConfiguration(args);
		this.reloadTabs = this.config.attach!.reloadTabs;

		let socket = await connect(this.config.attach!.port, this.config.attach!.host);

		this.startSession(socket);
	}

	protected setBreakpoints(args: DebugProtocol.SetBreakpointsArguments): Promise<{ breakpoints: DebugProtocol.Breakpoint[] }> {
		let breakpoints = args.breakpoints || [];
		log.debug(`Setting ${breakpoints.length} breakpoints for ${args.source.path}`);

		let sourcePath = args.source.path;
		let breakpointInfos = breakpoints.map((breakpoint) => <BreakpointInfo>{
			id: this.nextBreakpointId++,
			requestedLine: breakpoint.line,
			requestedColumn: breakpoint.column,
			condition: breakpoint.condition
		});

		//TODO handle undefined sourcePath
		this.breakpointsBySourcePath.set(sourcePath!, breakpointInfos);
		this.verifiedBreakpointSources = this.verifiedBreakpointSources.filter(
			(verifiedSourcePath) => (verifiedSourcePath !== sourcePath));

		return new Promise<{ breakpoints: DebugProtocol.Breakpoint[] }>((resolve, reject) => {

			this.threadsById.forEach((threadAdapter) => {

				let sourceAdapters = threadAdapter.findSourceAdaptersForPath(sourcePath);
				sourceAdapters.forEach((sourceAdapter) => {

					log.debug(`Found source ${args.source.path} on tab ${threadAdapter.actorName}`);

					let setBreakpointsPromise = threadAdapter.setBreakpoints(breakpointInfos, sourceAdapter);

					//TODO handle undefined sourcePath
					if (this.verifiedBreakpointSources.indexOf(sourcePath!) < 0) {

						setBreakpointsPromise.then(
							(breakpointAdapters) => {

								log.debug('Replying to setBreakpointsRequest with actual breakpoints from the first thread with this source');
								resolve({
									breakpoints: breakpointAdapters.map(
										(breakpointAdapter) => {
											let breakpoint: DebugProtocol.Breakpoint =
												new Breakpoint(true, 
												breakpointAdapter.breakpointInfo.actualLine,
												breakpointAdapter.breakpointInfo.actualColumn);
											breakpoint.id = breakpointAdapter.breakpointInfo.id;
											return breakpoint;
										})
								});
							});

						//TODO handle undefined sourcePath
						this.verifiedBreakpointSources.push(sourcePath!);
					}
				});
			});

			//TODO handle undefined sourcePath
			if (this.verifiedBreakpointSources.indexOf(sourcePath!) < 0) {
				log.debug (`Replying to setBreakpointsRequest (Source ${args.source.path} not seen yet)`);

				resolve({
					breakpoints: breakpointInfos.map((breakpointInfo) => {
						let breakpoint: DebugProtocol.Breakpoint =
							new Breakpoint(false, breakpointInfo.requestedLine, breakpointInfo.requestedColumn);
						breakpoint.id = breakpointInfo.id;
						return breakpoint;
					})
				});
			}
		});
	}

	protected setExceptionBreakpoints(args: DebugProtocol.SetExceptionBreakpointsArguments): void {
		log.debug(`Setting exception filters: ${JSON.stringify(args.filters)}`);

		this.exceptionBreakpoints = ExceptionBreakpoints.None;

		if (args.filters.indexOf('all') >= 0) {
			this.exceptionBreakpoints = ExceptionBreakpoints.All;
		} else if (args.filters.indexOf('uncaught') >= 0) {
			this.exceptionBreakpoints = ExceptionBreakpoints.Uncaught;
		}

		this.threadsById.forEach((threadAdapter) =>
			threadAdapter.setExceptionBreakpoints(this.exceptionBreakpoints));
	}

	protected async pause(args: DebugProtocol.PauseArguments): Promise<void> {

		let threadAdapter = this.getThreadAdapter(args.threadId);
		this.setActiveThread(threadAdapter);

		await threadAdapter.interrupt();

		let stoppedEvent = new StoppedEvent('interrupt', threadAdapter.id);
		(<DebugProtocol.StoppedEvent>stoppedEvent).body.allThreadsStopped = false;
		this.sendEvent(stoppedEvent);
	}

	protected async next(args: DebugProtocol.NextArguments): Promise<void> {

		let threadAdapter = this.getThreadAdapter(args.threadId);
		this.setActiveThread(threadAdapter);

		await threadAdapter.stepOver();
	}

	protected async stepIn(args: DebugProtocol.StepInArguments): Promise<void> {

		let threadAdapter = this.getThreadAdapter(args.threadId);
		this.setActiveThread(threadAdapter);

		await threadAdapter.stepIn();
	}

	protected async stepOut(args: DebugProtocol.StepOutArguments): Promise<void> {

		let threadAdapter = this.getThreadAdapter(args.threadId);
		this.setActiveThread(threadAdapter);

		await threadAdapter.stepOut();
	}

	protected async continue(args: DebugProtocol.ContinueArguments): Promise<{ allThreadsContinued?: boolean }> {

		let threadAdapter = this.getThreadAdapter(args.threadId);
		this.setActiveThread(threadAdapter);

		await threadAdapter.resume();
		return { allThreadsContinued: false };
	}

	protected async getSource(args: DebugProtocol.SourceArguments): Promise<{ content: string, mimeType?: string }> {

		let sourceAdapter = this.sourcesById.get(args.sourceReference);
		if (!sourceAdapter) {
			throw new Error('Failed sourceRequest: the requested source reference can\'t be found');
		}

		let sourceGrip = await sourceAdapter.actor.fetchSource();

		if (typeof sourceGrip === 'string') {

			return { content: sourceGrip };

		} else {

			let longStringGrip = <FirefoxDebugProtocol.LongStringGrip>sourceGrip;
			let longStringActor = this.getOrCreateLongStringGripActorProxy(longStringGrip);
			let content = await longStringActor.fetchContent();
			return { content };

		}
	}

	protected getThreads(): { threads: DebugProtocol.Thread[] } {
		
		log.debug(`${this.threadsById.size} threads`);

		let threads: Thread[] = [];
		this.threadsById.forEach((threadAdapter) => {
			threads.push(new Thread(threadAdapter.id, threadAdapter.name));
		});

		return { threads };
	}

	protected async getStackTrace(args: DebugProtocol.StackTraceArguments): Promise<{ stackFrames: DebugProtocol.StackFrame[], totalFrames?: number }> {

		let threadAdapter = this.getThreadAdapter(args.threadId);
		this.setActiveThread(threadAdapter);

		let [frameAdapters, totalFrames] = 
			await threadAdapter.fetchStackFrames(args.startFrame || 0, args.levels || 0);

		let stackFrames = frameAdapters.map((frameAdapter) => frameAdapter.getStackframe());

		return { stackFrames, totalFrames };
	}

	protected getScopes(args: DebugProtocol.ScopesArguments): { scopes: DebugProtocol.Scope[] } {

		let frameAdapter = this.framesById.get(args.frameId);
		if (!frameAdapter) {
			throw new Error('Failed scopesRequest: the requested frame can\'t be found');
		}

		this.setActiveThread(frameAdapter.threadAdapter);

		let scopes = frameAdapter.scopeAdapters.map((scopeAdapter) => scopeAdapter.getScope());

		return { scopes };
	}

	protected async getVariables(args: DebugProtocol.VariablesArguments): Promise<{ variables: DebugProtocol.Variable[] }> {

		let variablesProvider = this.variablesProvidersById.get(args.variablesReference);
		if (!variablesProvider) {
			throw new Error('Failed variablesRequest: the requested object reference can\'t be found');
		}

		this.setActiveThread(variablesProvider.threadAdapter);

		try {

			let variables = await variablesProvider.threadAdapter.fetchVariables(variablesProvider);

			return { variables };

		} catch(err) {

			let msg: string;
			if (err === 'No such actor') {
				msg = 'Value can\'t be inspected - this is probably due to Firefox bug #1249962';
			} else {
				msg = String(err);
			}

			return { variables: [new Variable('Error from debugger', msg)]};
		}
	}

	protected async setVariable(args: DebugProtocol.SetVariableArguments): Promise<{ value: string, variablesReference?: number }> {

		let variablesProvider = this.variablesProvidersById.get(args.variablesReference);
		if (variablesProvider === undefined) {
			throw new Error('Failed setVariableRequest: the requested context can\'t be found')
		}
		if (variablesProvider.referenceFrame === undefined) {
			throw new Error('Failed setVariableRequest: the requested context has no associated stack frame');
		}

		let referenceExpression = accessorExpression(variablesProvider.referenceExpression, args.name);
		let setterExpression = `${referenceExpression} = ${args.value}`;
		let frameActorName = variablesProvider.referenceFrame.frame.actor;
		let result = await variablesProvider.threadAdapter.consoleEvaluate(setterExpression, frameActorName);

		return { value: result.value, variablesReference: result.variablesReference };
	}

	protected async evaluate(args: DebugProtocol.EvaluateArguments): Promise<{ result: string, type?: string, variablesReference: number, namedVariables?: number, indexedVariables?: number }> {

		let variable: Variable | undefined = undefined;

		if (args.context === 'watch') {

			if (args.frameId !== undefined) {

				let frameAdapter = this.framesById.get(args.frameId);
				if (frameAdapter !== undefined) {

					this.setActiveThread(frameAdapter.threadAdapter);

					let threadAdapter = frameAdapter.threadAdapter;
					let frameActorName = frameAdapter.frame.actor;

					variable = await threadAdapter.evaluate(args.expression, frameActorName);

				} else {
					log.warn(`Couldn\'t find specified frame for evaluating ${args.expression}`);
					throw 'not available';
				}

			} else {

				let threadAdapter = this.findConsoleThread();
				if (threadAdapter !== undefined) {

					variable = await threadAdapter.evaluate(args.expression);

				} else {
					log.info(`Couldn't find a console for evaluating watch ${args.expression}`);
					throw 'not available';
				}
			}

		} else {

			let threadAdapter = this.findConsoleThread();
			if (threadAdapter !== undefined) {

				let frameActorName: string | undefined = undefined;
				if (args.frameId !== undefined) {
					let frameAdapter = this.framesById.get(args.frameId);
					if (frameAdapter !== undefined) {
						frameActorName = frameAdapter.frame.actor;
					}
				}

				variable = await threadAdapter.consoleEvaluate(args.expression, frameActorName);

			} else {
				log.info(`Couldn't find a console for evaluating ${args.expression}`);
				throw 'not available';
			}
		}

		return {
			result: variable.value,
			variablesReference: variable.variablesReference
		};
	}

	protected async getCompletions(args: DebugProtocol.CompletionsArguments): Promise<{ targets: DebugProtocol.CompletionItem[] }> {

		let matches: string[];

		if (args.frameId !== undefined) {

			let frameAdapter = this.framesById.get(args.frameId);

			if (frameAdapter === undefined) {
				log.warn(`Couldn\'t find specified frame for auto-completing ${args.text}`);
				throw 'not available';
			}
			if (!frameAdapter.threadAdapter.hasConsole) {
				log.warn(`Specified frame for auto-completing ${args.text} has no console`);
				throw 'not available';
			}

			this.setActiveThread(frameAdapter.threadAdapter);

			let threadAdapter = frameAdapter.threadAdapter;
			let frameActorName = frameAdapter.frame.actor;

			matches = await threadAdapter.autoComplete(args.text, args.column - 1, frameActorName);

		} else {

			let threadAdapter = this.findConsoleThread();

			if (threadAdapter === undefined) {
				log.warn(`Couldn't find a console for auto-completing ${args.text}`);
				throw 'not available';
			}

			matches = await threadAdapter.autoComplete(args.text, args.column - 1);
		}

		return { 
			targets: matches.map((match) => <DebugProtocol.CompletionItem>{ label: match })
		 };
	}

	protected async reloadAddon(): Promise<void> {
		if (!this.addonManager) {
			throw 'This command is only available when debugging an addon'
		}

		await this.addonManager.reloadAddon();
	}

	protected async rebuildAddon(): Promise<void> {
		if (!this.addonManager) {
			throw 'This command is only available when debugging an addon of type "addonSdk"';
		}

		await this.addonManager.rebuildAddon();
	}

	protected async disconnect(args: DebugProtocol.DisconnectArguments): Promise<void> {

		let detachPromises: Promise<void>[] = [];
		if (!this.firefoxDebugSocketClosed) {
			this.threadsById.forEach((threadAdapter) => {
				detachPromises.push(threadAdapter.detach());
			});
		}
		await Promise.all(detachPromises);

		await this.disconnectFirefoxAndCleanup();
	}

	public registerVariablesProvider(variablesProvider: VariablesProvider): number {
		let providerId = this.nextVariablesProviderId++;
		this.variablesProvidersById.set(providerId, variablesProvider);
		return providerId;
	}

	public unregisterVariablesProvider(variablesProvider: VariablesProvider) {
		this.variablesProvidersById.delete(variablesProvider.variablesProviderId);
	}

	public registerFrameAdapter(frameAdapter: FrameAdapter) {
		let frameId = this.nextFrameId++;
		frameAdapter.id = frameId;
		this.framesById.set(frameAdapter.id, frameAdapter);
	}

	public unregisterFrameAdapter(frameAdapter: FrameAdapter) {
		this.framesById.delete(frameAdapter.id);
	}

	public getOrCreateObjectGripActorProxy(objectGrip: FirefoxDebugProtocol.ObjectGrip): ObjectGripActorProxy {
		return this.firefoxDebugConnection.getOrCreate(objectGrip.actor, () =>
			new ObjectGripActorProxy(objectGrip, this.firefoxDebugConnection));
	}

	public getOrCreateLongStringGripActorProxy(longStringGrip: FirefoxDebugProtocol.LongStringGrip): LongStringGripActorProxy {
		return this.firefoxDebugConnection.getOrCreate(longStringGrip.actor, () =>
			new LongStringGripActorProxy(longStringGrip, this.firefoxDebugConnection));
	}

	private getThreadAdapter(threadId: number): ThreadAdapter {
		let threadAdapter = this.threadsById.get(threadId);
		if (!threadAdapter) {
			throw new Error(`Unknown threadId ${threadId}`);
		}
		return threadAdapter;
	}

	private startSession(socket: Socket) {

		this.firefoxDebugConnection = new DebugConnection(this.config.sourceMaps, socket);
		this.firefoxDebugSocketClosed = false;
		let rootActor = this.firefoxDebugConnection.rootActor;

		// attach to all tabs, register the corresponding threads and inform VSCode about them
		rootActor.onTabOpened(async ([tabActor, consoleActor]) => {
			log.info(`Tab opened with url ${tabActor.url}`);
			let tabId = this.nextTabId++;
			this.tabsById.set(tabId, tabActor);
			let threadAdapter = await this.attachTabOrAddon(tabActor, consoleActor, tabId, true, `Tab ${tabId}`);
			if (threadAdapter !== undefined) {
				this.attachConsole(consoleActor, threadAdapter);
			}
		});

		rootActor.onTabListChanged(() => {
			rootActor.fetchTabs();
		});

		rootActor.onInit(async () => {

			let actors = await rootActor.fetchTabs();

			if (this.addonManager) {
				this.addonManager.sessionStarted(rootActor, actors.addons, actors.preference, this);
			}

			this.reloadTabs = false;
		});

		socket.on('close', () => {
			log.info('Connection to Firefox closed - terminating debug session');
			this.firefoxDebugSocketClosed = true;
			this.sendEvent(new TerminatedEvent());
		});

		if (this.config.reloadOnChange) {

			this.reloadWatcher = chokidar.watch(this.config.reloadOnChange.watch, { 
				ignored: this.config.reloadOnChange.ignore,
				ignoreInitial: true
			});

			let reload: () => void;
			if (this.config.addon) {

				reload = () => {
					if (this.addonManager) {
						log.debug('Reloading add-on');
	
						this.addonManager.reloadAddon();
					}
				}

			} else {

				reload = () => {
					log.debug('Reloading tabs');

					for (let [, tabActor] of this.tabsById) {
						tabActor.reload();
					}
				}
			}

			if (this.config.reloadOnChange.debounce > 0) {
				reload = debounce(reload, this.config.reloadOnChange.debounce);
			}

			this.reloadWatcher.on('add', reload);
			this.reloadWatcher.on('change', reload);
			this.reloadWatcher.on('unlink', reload);
		}

		// now we are ready to accept breakpoints -> fire the initialized event to give UI a chance to set breakpoints
		this.sendEvent(new InitializedEvent());
	}

	public async attachTabOrAddon(tabActor: TabActorProxy, consoleActor: ConsoleActorProxy, tabId: number, 
		isTab: boolean, threadName: string): Promise<ThreadAdapter | undefined> {

		let reload = isTab && this.reloadTabs;

		let threadActor: IThreadActorProxy;
		try {
			threadActor = await tabActor.attach();
		} catch (err) {
			log.error(`Failed attaching to tab: ${err}`);
			return undefined;
		}

		log.debug(`Attached to tab ${tabActor.name}`);

		let threadId = this.nextThreadId++;
		let threadAdapter = new ThreadAdapter(threadId, threadActor, consoleActor,
			this.threadPauseCoordinator, threadName, this);

		this.attachThread(threadAdapter, threadActor.name);

		if (isTab) {

			let nextWorkerId = 1;
			tabActor.onWorkerStarted(async (workerActor) => {

				log.info(`Worker started with url ${tabActor.url}`);

				let workerId = nextWorkerId++;

				try {
					await this.attachWorker(workerActor, tabId, workerId);
				} catch (err) {
					log.error(`Failed attaching to worker: ${err}`);
				}
			});

			tabActor.onWorkerListChanged(() => tabActor.fetchWorkers());
			tabActor.fetchWorkers();

			tabActor.onDetached(() => {

				this.threadPauseCoordinator.threadTerminated(threadAdapter.id, threadAdapter.name);

				if (this.threadsById.has(threadId)) {
					this.threadsById.delete(threadId);
					this.sendEvent(new ThreadEvent('exited', threadId));
				}

				threadAdapter.dispose(true);

				if (this.tabsById.has(tabId)) {
					this.tabsById.delete(tabId);
				}

				tabActor.dispose();
			});
		}

		try {

			await threadAdapter.init(this.exceptionBreakpoints, reload);

			this.threadsById.set(threadId, threadAdapter);
			this.sendEvent(new ThreadEvent('started', threadId));

			return threadAdapter;

		} catch (err) {
			// When the user closes a tab, Firefox creates an invisible tab and
			// immediately closes it again (while we're still trying to attach to it),
			// so the initialization for this invisible tab fails and we end up here.
			// Since we never sent the current threadId to VSCode, we can re-use it
			if (this.nextThreadId == (threadId + 1)) {
				this.nextThreadId--;
			}
			log.info(`Failed attaching to tab: ${err}`);

			return undefined;
		}
	}

	private async attachWorker(workerActor: WorkerActorProxy, tabId: number, workerId: number): Promise<void> {

		await workerActor.attach();
		let threadActor = await workerActor.connect();

		log.debug(`Attached to worker ${workerActor.name}`);

		let threadId = this.nextThreadId++;
		let threadAdapter = new ThreadAdapter(threadId, threadActor, undefined,
			this.threadPauseCoordinator, `Worker ${tabId}/${workerId}`, this);

		this.attachThread(threadAdapter, threadActor.name);

		await threadAdapter.init(this.exceptionBreakpoints, false);

		this.threadsById.set(threadId, threadAdapter);
		this.sendEvent(new ThreadEvent('started', threadId));

		workerActor.onClose(() => {
			this.threadsById.delete(threadId);
			this.sendEvent(new ThreadEvent('exited', threadId));
		});
	}

	private attachThread(threadAdapter: ThreadAdapter, actorName: string): void {

		threadAdapter.onNewSource((sourceActor) => {
			this.attachSource(sourceActor, threadAdapter);
		});

		threadAdapter.onPaused((reason) => {
			log.info(`Thread ${actorName} paused , reason: ${reason.type}`);

			let stoppedEvent: DebugProtocol.StoppedEvent = new StoppedEvent(reason.type, threadAdapter.id);
			stoppedEvent.body.allThreadsStopped = false;

			if (reason.exception) {

				if (typeof reason.exception === 'string') {

					stoppedEvent.body.text = reason.exception;

				} else if ((typeof reason.exception === 'object') && (reason.exception.type === 'object')) {

					let exceptionGrip = <FirefoxDebugProtocol.ObjectGrip>reason.exception;
					if (exceptionGrip.preview.message) {
						stoppedEvent.body.text = `${exceptionGrip.class}: ${exceptionGrip.preview.message}`;
					} else {
						stoppedEvent.body.text = exceptionGrip.class;
					}
				}
			}

			this.sendEvent(stoppedEvent);
		});

		threadAdapter.onResumed(() => {
			log.info(`Thread ${actorName} resumed unexpectedly`);
			this.sendEvent(new ContinuedEvent(threadAdapter.id));
		});

		threadAdapter.onExited(() => {
			log.info(`Thread ${actorName} exited`);
			this.threadsById.delete(threadAdapter.id);
			this.sendEvent(new ThreadEvent('exited', threadAdapter.id));
		});
	}

	private attachSource(sourceActor: ISourceActorProxy, threadAdapter: ThreadAdapter): void {

		const source = sourceActor.source;
		const sourcePath = this.pathMapper.convertFirefoxSourceToPath(source);
		let sourceAdapter = threadAdapter.findCorrespondingSourceAdapter(source);

		if (sourceAdapter !== undefined) {

			sourceAdapter.actor = sourceActor;

		} else {

			let sourceId = this.nextSourceId++;
			sourceAdapter = threadAdapter.createSourceAdapter(sourceId, sourceActor, sourcePath);
			this.sourcesById.set(sourceId, sourceAdapter);

		}

		// check if this source should be skipped
		let pathToCheck: string | null | undefined = undefined;
		if (sourcePath !== undefined) {
			pathToCheck = sourcePath;
			if (isWindowsPlatform) {
				pathToCheck = pathToCheck.split('\\').join('/');
			}
		} else if (source.generatedUrl && (!source.url || !urlDetector.test(source.url))) {
			pathToCheck = source.generatedUrl;
		} else {
			pathToCheck = source.url;
		}

		if (pathToCheck) {

			let skipThisSource = false;
			for (let regExp of this.config.filesToSkip) {
				if (regExp.test(pathToCheck)) {
					skipThisSource = true;
					break;
				}
			}

			if (source.isBlackBoxed !== skipThisSource) {
				sourceActor.setBlackbox(skipThisSource);
			}
		}

		if (sourcePath && this.breakpointsBySourcePath.has(sourcePath)) {

			let breakpointInfos = this.breakpointsBySourcePath.get(sourcePath) || [];

			if (sourceAdapter !== undefined) {

				let setBreakpointsPromise = threadAdapter.setBreakpoints(
					breakpointInfos, sourceAdapter);

				if (this.verifiedBreakpointSources.indexOf(sourcePath) < 0) {

					setBreakpointsPromise.then((breakpointAdapters) => {

						log.debug('Updating breakpoints');

						breakpointAdapters.forEach((breakpointAdapter) => {
							let breakpoint: DebugProtocol.Breakpoint =
								new Breakpoint(true, breakpointAdapter.breakpointInfo.actualLine);
							breakpoint.id = breakpointAdapter.breakpointInfo.id;
							this.sendEvent(new BreakpointEvent('update', breakpoint));
						})

						this.verifiedBreakpointSources.push(sourcePath);
					})
				}
			};
		}
	}

	//TODO make private again
	public attachConsole(consoleActor: ConsoleActorProxy, threadAdapter: ThreadAdapter): void {

		consoleActor.onConsoleAPICall((consoleEvent) => {
			consoleActorLog.debug(`Console API: ${JSON.stringify(consoleEvent)}`);

			let category = (consoleEvent.level === 'error') ? 'stderr' :
				(consoleEvent.level === 'warn') ? 'console' : 'stdout';

			let outputEvent: DebugProtocol.OutputEvent;
			if ((consoleEvent.arguments.length === 1) && (typeof consoleEvent.arguments[0] !== 'object')) {

				let msg = String(consoleEvent.arguments[0]);
				if (this.config.showConsoleCallLocation) {
					let filename = this.pathMapper.convertFirefoxUrlToPath(consoleEvent.filename);
					msg += ` (${filename}:${consoleEvent.lineNumber}:${consoleEvent.columnNumber})`;
				}
				outputEvent = new OutputEvent(msg + '\n', category);

			} else {

				let args = consoleEvent.arguments.map((grip, index) =>
					VariableAdapter.fromGrip(String(index), undefined, undefined, grip, true, threadAdapter));

				if (this.config.showConsoleCallLocation) {
					let filename = this.pathMapper.convertFirefoxUrlToPath(consoleEvent.filename);
					let locationVar = new VariableAdapter(
						'location', undefined, undefined,
						`(${filename}:${consoleEvent.lineNumber}:${consoleEvent.columnNumber})`,
						threadAdapter);
					args.push(locationVar);
				}

				let argsAdapter = new ConsoleAPICallAdapter(args, threadAdapter);

				outputEvent = new OutputEvent('', category);
				outputEvent.body.variablesReference = argsAdapter.variablesProviderId;
			}

			this.sendEvent(outputEvent);
		});

		consoleActor.onPageErrorCall((err) => {
			consoleActorLog.debug(`Page Error: ${JSON.stringify(err)}`);

			if (err.category === 'content javascript') {
				let category = err.exception ? 'stderr' : 'stdout';
				this.sendEvent(new OutputEvent(err.errorMessage + '\n', category));
			}
		});

		consoleActor.startListeners();
		consoleActor.getCachedMessages();
	}

	private setActiveThread(threadAdapter: ThreadAdapter): void {
		if (threadAdapter.hasConsole) {
			this.lastActiveConsoleThreadId = threadAdapter.id;
		}
	}

	private findConsoleThread(): ThreadAdapter | undefined {

		let threadAdapter: ThreadAdapter | undefined = this.threadsById.get(this.lastActiveConsoleThreadId);
		if (threadAdapter !== undefined) {
			return threadAdapter;
		}

		for (let i = 1; i < this.nextThreadId; i++) {
			if (this.threadsById.has(i)) {
				threadAdapter = this.threadsById.get(i)!;
				if (threadAdapter.hasConsole) {
					this.setActiveThread(threadAdapter);
					return threadAdapter;
				}
			}
		}

		return undefined;
	}

	private async disconnectFirefoxAndCleanup(): Promise<void> {

		if (this.reloadWatcher !== undefined) {
			this.reloadWatcher.close();
			this.reloadWatcher = undefined;
		}

		if (!this.firefoxDebugSocketClosed) {
			await this.firefoxDebugConnection.disconnect();
		}

		if (this.config.launch) {
			let launchConfig = this.config.launch;

			if (this.firefoxProc) {
				let firefoxProc = this.firefoxProc;

				if (launchConfig.tmpDirs.length > 0) {

					await new Promise<void>((resolve) => {

						this.firefoxProc!.once('exit', async () => {
							try {
								await Promise.all(launchConfig.tmpDirs.map(
									(tmpDir) => this.tryRemoveRepeatedly(tmpDir)));
							} catch (err) {
								log.warn(`Failed to remove temporary directory: ${err}`);
							}
							resolve();
						});

						firefoxProc.kill('SIGTERM');
					});

				} else {
					firefoxProc.kill('SIGTERM');
				}

				this.firefoxProc = undefined;
			}
		}
	}

	private async tryRemoveRepeatedly(dir: string): Promise<void> {
		for (var i = 0; i < 5; i++) {
			try {
				await this.tryRemove(dir);
				log.debug(`Removed ${dir}`);
				return;
			} catch (err) {
				if (i < 4) {
					log.debug(`Attempt to remove ${dir} failed, will retry in 100ms`);
					await delay(100);
				} else {
					log.debug(`Attempt to remove ${dir} failed, giving up`);
					throw err;
				}
			}
		}
	}

	private tryRemove(dir: string): Promise<void> {
		return new Promise<void>((resolve, reject) => {
			fs.remove(dir, (err) => {
				if (!err) {
					resolve();
				} else {
					reject(err);
				}
			})
		})
	}
}

DebugSession.run(FirefoxDebugAdapter);
