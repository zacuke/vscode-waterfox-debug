import * as os from 'os';
import * as path from 'path';
import { Socket } from 'net';
import { ChildProcess } from 'child_process';
import { Log } from './util/log';
import { concatArrays } from './util/misc';
import { findAddonId } from './util/addon';
import { launchFirefox, connect, waitForSocket } from './util/launcher';
import { Minimatch } from 'minimatch';
import { DebugProtocol } from 'vscode-debugprotocol';
import { DebugAdapterBase } from './debugAdapterBase';
import { DebugSession, InitializedEvent, TerminatedEvent, StoppedEvent, OutputEvent, ThreadEvent, BreakpointEvent, ContinuedEvent, Thread, StackFrame, Scope, Variable, Source, Breakpoint } from 'vscode-debugadapter';
import { DebugConnection, ActorProxy, TabActorProxy, WorkerActorProxy, ThreadActorProxy, ConsoleActorProxy, ExceptionBreakpoints, SourceActorProxy, BreakpointActorProxy, ObjectGripActorProxy, LongStringGripActorProxy } from './firefox/index';
import { ThreadAdapter, BreakpointInfo, BreakpointsAdapter, SourceAdapter, BreakpointAdapter, FrameAdapter, EnvironmentAdapter, VariablesProvider, VariableAdapter, ObjectGripAdapter } from './adapter/index';
import { CommonConfiguration, LaunchConfiguration, AttachConfiguration, AddonType } from './adapter/launchConfiguration';

let log = Log.create('FirefoxDebugAdapter');
let pathConversionLog = Log.create('PathConversion');
let consoleActorLog = Log.create('ConsoleActor');

export class FirefoxDebugAdapter extends DebugAdapterBase {

	private firefoxProc?: ChildProcess;
	private firefoxDebugConnection: DebugConnection;
	private firefoxDebugSocketClosed: boolean;

	private pathMappings: [string | RegExp, string][] = [];
	private filesToSkip: RegExp[] = [];
	private addonType: AddonType | undefined;
	private addonId: string | undefined;
	private addonPath: string | undefined;
	private isWindowsPlatform: boolean;

	private nextThreadId = 1;
	private threadsById = new Map<number, ThreadAdapter>();
	private lastActiveConsoleThreadId: number = 0;

	private nextBreakpointId = 1;
	private breakpointsBySourcePath = new Map<string, BreakpointInfo[]>();
	private verifiedBreakpointSources: string[] = [];

	private nextFrameId = 1;
	private framesById = new Map<number, FrameAdapter>();

	private nextVariablesProviderId = 1;
	private variablesProvidersById = new Map<number, VariablesProvider>();

	private nextSourceId = 1;
	private sourcesById = new Map<number, SourceAdapter>();

	private exceptionBreakpoints: ExceptionBreakpoints = ExceptionBreakpoints.All;

	public constructor(debuggerLinesStartAt1: boolean, isServer: boolean = false) {
		super(debuggerLinesStartAt1, isServer);

		this.isWindowsPlatform = (os.platform() === 'win32');

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

	protected async launch(args: LaunchConfiguration): Promise<void> {

		await this.readCommonConfiguration(args);

		this.firefoxProc = await launchFirefox(args,
			(msg) => this.sendEvent(new OutputEvent(msg, 'stdout')));

		let socket = await waitForSocket(args);
		this.startSession(socket);
	}

	protected async attach(args: AttachConfiguration): Promise<void> {

		await this.readCommonConfiguration(args);

		let socket = await connect(args.port || 6000, args.host || 'localhost');
		this.startSession(socket);
	}

	protected setBreakpoints(args: DebugProtocol.SetBreakpointsArguments): Promise<{ breakpoints: DebugProtocol.Breakpoint[] }> {
		let breakpoints = args.breakpoints || [];
		log.debug(`Setting ${breakpoints.length} breakpoints for ${args.source.path}`);

		let sourcePath = args.source.path;
		let breakpointInfos = breakpoints.map((breakpoint) => <BreakpointInfo>{
			id: this.nextBreakpointId++,
			requestedLine: breakpoint.line,
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
												new Breakpoint(true, breakpointAdapter.breakpointInfo.actualLine);
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
							new Breakpoint(false, breakpointInfo.requestedLine);
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

		let variables = await variablesProvider.threadAdapter.fetchVariables(variablesProvider);

		return { variables };
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

	protected async disconnect(args: DebugProtocol.DisconnectArguments): Promise<void> {

		let detachPromises: Promise<void>[] = [];
		if (!this.firefoxDebugSocketClosed) {
			this.threadsById.forEach((threadAdapter) => {
				detachPromises.push(threadAdapter.detach());
			});
		}
		await Promise.all(detachPromises);

		this.disconnectFirefox();
	}

	public registerVariablesProvider(variablesProvider: VariablesProvider) {
		let providerId = this.nextVariablesProviderId++;
		variablesProvider.variablesProviderId = providerId;
		this.variablesProvidersById.set(providerId, variablesProvider);
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

	public convertFirefoxSourceToPath(source: FirefoxDebugProtocol.Source): string | undefined {
		if (!source) return undefined;

		if (source.addonID && (source.addonID === this.addonId)) {

			let sourcePath = this.removeQueryString(path.join(this.addonPath, source.addonPath));
			pathConversionLog.debug(`Addon script path: ${sourcePath}`);
			return sourcePath;

		} else if (source.isSourceMapped && source.generatedUrl && source.url && !this.urlDetector.test(source.url)) {

			let generatedPath = this.convertFirefoxUrlToPath(source.generatedUrl);
			if (!generatedPath) return undefined;

			let relativePath = source.url;

			let sourcePath = this.removeQueryString(path.join(path.dirname(generatedPath), relativePath));
			pathConversionLog.debug(`Sourcemapped path: ${sourcePath}`);
			return sourcePath;

		} else if (source.url) {
			return this.convertFirefoxUrlToPath(source.url);
		} else {
			return undefined;
		}
	}

	private urlDetector = /^[a-zA-Z][a-zA-Z0-9\+\-\.]*\:\/\//;

	private convertFirefoxUrlToPath(url: string): string | undefined {

		for (var i = 0; i < this.pathMappings.length; i++) {

			let [from, to] = this.pathMappings[i];

			if (typeof from === 'string') {

				if (url.substr(0, from.length) === from) {

					let path = this.removeQueryString(to + url.substr(from.length));
					if (this.isWindowsPlatform) {
						path = path.replace(/\//g, '\\');
					}

					pathConversionLog.debug(`Converted url ${url} to path ${path}`);
					return path;
				}

			} else {

				let match = from.exec(url);
				if (match) {

					let path = this.removeQueryString(to + match[1]);
					if (this.isWindowsPlatform) {
						path = path.replace(/\//g, '\\');
					}

					pathConversionLog.debug(`Converted url ${url} to path ${path}`);
					return path;
				}
			}
		}

		if ((url.substr(0, 11) === 'resource://') || (url.substr(0, 9) === 'chrome://') ||
			(url === 'XStringBundle') || (url.substr(0, 4) === 'jar:')) {
			pathConversionLog.info(`Can't convert url ${url} to path`);
		} else {
			pathConversionLog.warn(`Can't convert url ${url} to path`);
		}

		return undefined;
	}

	private removeQueryString(path: string): string {
		let queryStringIndex = path.indexOf('?');
		if (queryStringIndex >= 0) {
			return path.substr(0, queryStringIndex);
		} else {
			return path;
		}
	}

	private async readCommonConfiguration(args: CommonConfiguration): Promise<void> {

		if (args.log) {
			Log.config = args.log;
		}

		if (args.pathMappings) {
			args.pathMappings.forEach((pathMapping) => {
				this.pathMappings.push([ pathMapping.url, pathMapping.path ]);
			});
		}

		if (args.addonType) {

			if (!args.addonPath) {
				throw `If you set "addonType" you also have to set "addonPath" in the ${args.request} configuration`;
			}

			this.addonType = args.addonType;

			let success: boolean;
			let addonIdOrErrorMsg: string;
			this.addonId = await findAddonId(args.addonPath);
			this.addonPath = args.addonPath;

			if (this.addonType === 'addonSdk') {

				let rewrittenAddonId = this.addonId.replace("@", "-at-");
				let sanitizedAddonPath = this.addonPath;
				if (sanitizedAddonPath[sanitizedAddonPath.length - 1] === '/') {
					sanitizedAddonPath = sanitizedAddonPath.substr(0, sanitizedAddonPath.length - 1);
				}
				this.pathMappings.push([ 'resource://' + rewrittenAddonId, sanitizedAddonPath ]);

			} else if (this.addonType === 'webExtension') {

				let rewrittenAddonId = this.addonId.replace('{', '%7B').replace('}', '%7D');
				let sanitizedAddonPath = this.addonPath;
				if (sanitizedAddonPath[sanitizedAddonPath.length - 1] === '/') {
					sanitizedAddonPath = sanitizedAddonPath.substr(0, sanitizedAddonPath.length - 1);
				}
				this.pathMappings.push([ new RegExp('^moz-extension://[0-9a-f-]*(/.*)$'), sanitizedAddonPath]);
				this.pathMappings.push([ new RegExp(`^jar:file:.*/extensions/${rewrittenAddonId}.xpi!(/.*)$`), sanitizedAddonPath ]);

			}

		} else if (args.addonPath) {

			throw `If you set "addonPath" you also have to set "addonType" in the ${args.request} configuration`;

		} else if (args.url) {

			if (!args.webRoot) {
				throw `If you set "url" you also have to set "webRoot" in the ${args.request} configuration`;
			} else if (!path.isAbsolute(args.webRoot)) {
				throw `The "webRoot" property in the ${args.request} configuration has to be an absolute path`;
			}

			let webRootUrl = args.url;
			if (webRootUrl.indexOf('/') >= 0) {
				webRootUrl = webRootUrl.substr(0, webRootUrl.lastIndexOf('/'));
			}

			let webRoot = path.normalize(args.webRoot);
			if (this.isWindowsPlatform) {
				webRoot = webRoot.replace(/\\/g, '/');
			}
			if (webRoot[webRoot.length - 1] === '/') {
				webRoot = webRoot.substr(0, webRoot.length - 1);
			}

			this.pathMappings.forEach((pathMapping) => {
				const to = pathMapping[1];
				if ((typeof to === 'string') && (to.substr(0, 10) === '${webRoot}')) {
					pathMapping[1] = webRoot + to.substr(10);
				}
			});

			this.pathMappings.push([ webRootUrl, webRoot ]);

		} else if (args.webRoot) {

			throw `If you set "webRoot" you also have to set "url" in the ${args.request} configuration`;

		}

		this.pathMappings.push([(this.isWindowsPlatform ? 'file:///' : 'file://'), '']);

		pathConversionLog.info('Path mappings:');
		this.pathMappings.forEach(([from, to]) => pathConversionLog.info(`'${from}' => '${to}'`));

		if (args.skipFiles) {
			args.skipFiles.forEach((glob) => {

				let minimatch = new Minimatch(glob);
				let regExp = minimatch.makeRe();

				if (regExp) {
					this.filesToSkip.push(regExp);
				} else {
					log.warn(`Invalid glob pattern "${glob}" specified in "skipFiles"`);
				}
			})
		}

		return undefined;
	}

	private startSession(socket: Socket) {

		this.firefoxDebugConnection = new DebugConnection(socket);
		this.firefoxDebugSocketClosed = false;
		let rootActor = this.firefoxDebugConnection.rootActor;

		let nextTabId = 1;

		if (this.addonId) {
			// attach to Firefox addon
			rootActor.onInit(async () => {

				let addons = await rootActor.fetchAddons();
				addons.forEach((addon) => {
					if (addon.id === this.addonId) {
						let tabActor = new TabActorProxy(addon.actor, addon.name, '', this.firefoxDebugConnection);
						let consoleActor = new ConsoleActorProxy(addon.consoleActor, this.firefoxDebugConnection);
						this.attachTab(tabActor, consoleActor, nextTabId++, false, 'Addon');
						this.attachConsole(consoleActor);
					}
				});

				if (this.addonType === 'legacy') {
					rootActor.fetchProcess().then(([tabActor, consoleActor]) => {
						this.attachTab(tabActor, consoleActor, nextTabId++, true, 'Browser');
					});
				}
			});
		}

		// attach to all tabs, register the corresponding threads and inform VSCode about them
		rootActor.onTabOpened(([tabActor, consoleActor]) => {
			log.info(`Tab opened with url ${tabActor.url}`);
			let tabId = nextTabId++;
			this.attachTab(tabActor, consoleActor, tabId);
			this.attachConsole(consoleActor);
		});

		rootActor.onTabListChanged(() => {
			rootActor.fetchTabs();
		});

		rootActor.onInit(() => {
			rootActor.fetchTabs();
		});

		socket.on('close', () => {
			log.info('Connection to Firefox closed - terminating debug session');
			this.firefoxDebugSocketClosed = true;
			this.sendEvent(new TerminatedEvent());
		});

		// now we are ready to accept breakpoints -> fire the initialized event to give UI a chance to set breakpoints
		this.sendEvent(new InitializedEvent());
	}

	private async attachTab(tabActor: TabActorProxy, consoleActor: ConsoleActorProxy, tabId: number, 
		hasWorkers: boolean = true, threadName?: string): Promise<void> {

		let threadActor: ThreadActorProxy;
		try {
			threadActor = await tabActor.attach();
		} catch (err) {
			log.error(`Failed attaching to tab: ${err}`);
			return;
		}

		log.debug(`Attached to tab ${tabActor.name}`);

		let threadId = this.nextThreadId++;
		if (!threadName) {
			threadName = `Tab ${tabId}`;
		}
		let threadAdapter = new ThreadAdapter(threadId, threadActor, consoleActor, threadName, this);

		this.attachThread(threadAdapter, threadActor.name);

		if (hasWorkers) {

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
		}

		try {

			await threadAdapter.init(this.exceptionBreakpoints)

			this.threadsById.set(threadId, threadAdapter);
			this.sendEvent(new ThreadEvent('started', threadId));

			tabActor.onDetached(() => {
				this.threadsById.delete(threadId);
				this.sendEvent(new ThreadEvent('exited', threadId));
			});

		} catch (err) {
			// When the user closes a tab, Firefox creates an invisible tab and
			// immediately closes it again (while we're still trying to attach to it),
			// so the initialization for this invisible tab fails and we end up here.
			// Since we never sent the current threadId to VSCode, we can re-use it
			if (this.nextThreadId == (threadId + 1)) {
				this.nextThreadId--;
			}
			log.info(`Failed attaching to tab: ${err}`);
		}
	}

	private async attachWorker(workerActor: WorkerActorProxy, tabId: number, workerId: number): Promise<void> {

		let url = await workerActor.attach();
		let threadActor = await workerActor.connect();

		log.debug(`Attached to worker ${workerActor.name}`);

		let threadId = this.nextThreadId++;
		let threadAdapter = new ThreadAdapter(threadId, threadActor, undefined,
			`Worker ${tabId}/${workerId}`, this);

		this.attachThread(threadAdapter, threadActor.name);

		await threadAdapter.init(this.exceptionBreakpoints);

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
			let stoppedEvent = new StoppedEvent(reason.type, threadAdapter.id);
			(<DebugProtocol.StoppedEvent>stoppedEvent).body.allThreadsStopped = false;
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

	private attachSource(sourceActor: SourceActorProxy, threadAdapter: ThreadAdapter): void {

		const source = sourceActor.source;
		const sourcePath = this.convertFirefoxSourceToPath(source);
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
			if (this.isWindowsPlatform) {
				pathToCheck = pathToCheck.split('\\').join('/');
			}
		} else if (source.generatedUrl && (!source.url || !this.urlDetector.test(source.url))) {
			pathToCheck = source.generatedUrl;
		} else {
			pathToCheck = source.url;
		}

		if (pathToCheck) {

			let skipThisSource = false;
			for (let regExp of this.filesToSkip) {
				if (regExp.test(pathToCheck)) {
					skipThisSource = true;
					break;
				}
			}

			if (source.isBlackBoxed !== skipThisSource) {
				sourceActor.setBlackbox(skipThisSource);
				source.isBlackBoxed = skipThisSource;
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

	private attachConsole(consoleActor: ConsoleActorProxy): void {

		consoleActor.onConsoleAPICall((msg) => {
			consoleActorLog.debug(`Console API: ${JSON.stringify(msg)}`);

			let category = (msg.level === 'error') ? 'stderr' :
				(msg.level === 'warn') ? 'console' : 'stdout';
			let displayMsg = msg.arguments.join(',') + '\n';
			this.sendEvent(new OutputEvent(displayMsg, category));
		});

		consoleActor.onPageErrorCall((err) => {
			consoleActorLog.debug(`Page Error: ${JSON.stringify(err)}`);

			if (err.category === 'content javascript') {
				let category = err.exception ? 'stderr' : 'stdout';
				this.sendEvent(new OutputEvent(err.errorMessage + '\n', category));
			}
		});

		consoleActor.startListeners();
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

	private async disconnectFirefox(): Promise<void> {
		if (this.firefoxDebugConnection) {
			await this.firefoxDebugConnection.disconnect();
			if (this.firefoxProc) {
				this.firefoxProc.kill('SIGTERM');
				this.firefoxProc = undefined;
			}
		}
	}
}

DebugSession.run(FirefoxDebugAdapter);
