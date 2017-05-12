import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs-extra';
import { Socket } from 'net';
import { ChildProcess } from 'child_process';
import * as uuid from 'uuid';
import { Minimatch } from 'minimatch';
import * as chokidar from 'chokidar';
import debounce = require('debounce');
import { DebugProtocol } from 'vscode-debugprotocol';
import { DebugSession, InitializedEvent, TerminatedEvent, StoppedEvent, OutputEvent, ThreadEvent, BreakpointEvent, ContinuedEvent, Thread, Variable, Breakpoint } from 'vscode-debugadapter';
import { Log } from './util/log';
import { delay, accessorExpression } from "./util/misc";
import { createXpi, buildAddonDir, findAddonId } from './util/addon';
import { launchFirefox, connect, waitForSocket } from './util/launcher';
import { DebugAdapterBase } from './debugAdapterBase';
import { DebugConnection, RootActorProxy, TabActorProxy, WorkerActorProxy, ThreadActorProxy, ConsoleActorProxy, ExceptionBreakpoints, SourceActorProxy, ObjectGripActorProxy, LongStringGripActorProxy } from './firefox/index';
import { ThreadAdapter, ThreadPauseCoordinator, BreakpointInfo, SourceAdapter, FrameAdapter, VariableAdapter, VariablesProvider, ConsoleAPICallAdapter } from './adapter/index';
import { CommonConfiguration, LaunchConfiguration, AttachConfiguration, AddonType, ReloadConfiguration, DetailedReloadConfiguration, NormalizedReloadConfiguration } from './adapter/launchConfiguration';

let log = Log.create('FirefoxDebugAdapter');
let pathConversionLog = Log.create('PathConversion');
let consoleActorLog = Log.create('ConsoleActor');

export class FirefoxDebugAdapter extends DebugAdapterBase {

	private firefoxProc?: ChildProcess;
	private debugProfileDir?: string;
	private firefoxDebugConnection: DebugConnection;
	private firefoxDebugSocketClosed: boolean;

	private pathMappings: [string | RegExp, string][] = [];
	private filesToSkip: RegExp[] = [];
	private showConsoleCallLocation = false;
	private addonType?: AddonType;
	private addonId?: string;
	private addonPath?: string;
	private addonBuildPath?: string;
	private isWindowsPlatform: boolean;

	private reloadConfig?: NormalizedReloadConfiguration;
	private reloadWatcher?: chokidar.FSWatcher;

	private reloadTabs = false;

	private nextTabId = 1;
	private tabsById = new Map<number, TabActorProxy>();

	private addonActor: TabActorProxy | undefined = undefined;
	private addonAttached = false;

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

	protected async launch(args: LaunchConfiguration): Promise<void> {

		await this.readCommonConfiguration(args);

		let installAddonViaRDP = false;
		if (args.addonType && args.addonPath) {
			if (args.installAddonInProfile !== undefined) {
				if (args.installAddonInProfile && args.reAttach) {
					throw '"installAddonInProfile" is not available with "reAttach"';
				}
				installAddonViaRDP = !args.installAddonInProfile;
			} else {
				installAddonViaRDP = !!args.reAttach;
			}
		}

		let socket: Socket | undefined = undefined;

		if (args.reAttach) {

			try {

				socket = await connect(args.port || 6000, 'localhost');

				if (args.reloadOnAttach !== undefined) {
					this.reloadTabs = args.reloadOnAttach;
				} else {
					this.reloadTabs = true;
				}

				installAddonViaRDP = this.reloadTabs;

			} catch(err) {}
		}

		if (socket === undefined) {

			let tempXpiDir: string | undefined = undefined;
			let tempXpiPath: string | undefined = undefined;

			if (args.addonType && args.addonPath) {

				if (installAddonViaRDP && (args.addonType === 'addonSdk')) {
					this.addonBuildPath = path.join(os.tmpdir(), `vscode-firefox-debug-addon-${uuid.v4()}`);
				}

				if (!installAddonViaRDP) {
					tempXpiDir = path.join(os.tmpdir(), `vscode-firefox-debug-${uuid.v4()}`);
					fs.mkdirSync(tempXpiDir);
					tempXpiPath = await createXpi(args.addonType, args.addonPath, tempXpiDir);
				}
			}

			// send messages from Firefox' stdout to the debug console when debugging an addonSdk extension
			let sendToConsole: (msg: string) => void = 
				(this.addonType === 'addonSdk') ? 
					(msg) => this.sendEvent(new OutputEvent(msg + '\n', 'stdout')) :
					(msg) => undefined;

			[this.firefoxProc, this.debugProfileDir] = await launchFirefox(
				args, tempXpiPath, this.addonBuildPath, sendToConsole);

			socket = await waitForSocket(args.port || 6000);

			if (tempXpiDir !== undefined) {
				fs.removeSync(tempXpiDir);
			}
		}

		this.startSession(socket, installAddonViaRDP);
	}

	protected async attach(args: AttachConfiguration): Promise<void> {

		await this.readCommonConfiguration(args);

		if (args.reloadOnAttach !== undefined) {
			this.reloadTabs = args.reloadOnAttach;
		}

		let installAddonViaRDP = false;
		if (args.addonType && args.addonPath) {

			installAddonViaRDP = true;

			if (args.addonType === 'addonSdk') {
				throw 'Attach mode is currently not supported for addonType "addonSdk"';
			}
		}

		let socket = await connect(args.port || 6000, args.host || 'localhost');
		this.startSession(socket, installAddonViaRDP);
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
		if (!this.addonPath) {
			throw 'This command is only available when debugging an addon'
		} else if (!this.addonActor) {
			throw 'Addon isn\'t attached';
		}

		if (this.addonBuildPath) {
			fs.copySync(this.addonPath, this.addonBuildPath);
		}

		await this.addonActor.reload();
	}

	protected async rebuildAddon(): Promise<void> {
		if (!this.addonPath || !this.addonBuildPath) {
			throw 'This command is only available when debugging an addon of type "addonSdk"';
		}

		await buildAddonDir(this.addonPath, this.addonBuildPath);
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

	public convertFirefoxSourceToPath(source: FirefoxDebugProtocol.Source): string | undefined {
		if (!source) return undefined;

		if (source.addonID && (source.addonID === this.addonId)) {

			let sourcePath = this.removeQueryString(path.join(this.addonPath!, source.addonPath!));
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

	private urlDetector = /^[a-zA-Z][a-zA-Z0-9\+\-\.]*\:\//;

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

		pathConversionLog.info(`Can't convert url ${url} to path`);

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

		if (args.reloadOnChange) {
			this.reloadConfig = this.readReloadConfiguration(<ReloadConfiguration>args.reloadOnChange);
		}

		if (args.pathMappings) {
			args.pathMappings.forEach((pathMapping) => {
				this.pathMappings.push([ pathMapping.url, pathMapping.path ]);
			});
		}

		if (args.showConsoleCallLocation !== undefined) {
			this.showConsoleCallLocation = args.showConsoleCallLocation;
		}

		if (args.addonType) {

			if (!args.addonPath) {
				throw `If you set "addonType" you also have to set "addonPath" in the ${args.request} configuration`;
			}

			this.addonType = args.addonType;

			this.addonId = await findAddonId(args.addonPath);
			this.addonPath = path.normalize(args.addonPath);

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

	private readReloadConfiguration(config: ReloadConfiguration): NormalizedReloadConfiguration {

		const defaultDebounce = 100;

		if (typeof config === 'string') {

			return {
				watch: [ config ],
				ignore: [],
				debounce: defaultDebounce
			};

		} else if (config['watch'] === undefined) {

			return {
				watch: <string[]>config,
				ignore: [],
				debounce: defaultDebounce
			};

		} else {

			let _config = <DetailedReloadConfiguration>config;

			let watch: string[];
			if (typeof _config.watch === 'string') {
				watch = [ _config.watch ];
			} else {
				watch = _config.watch;
			}

			let ignore: string[];
			if (_config.ignore === undefined) {
				ignore = [];
			} else if (typeof _config.ignore === 'string') {
				ignore = [ _config.ignore ];
			} else {
				ignore = _config.ignore;
			}

			let debounce: number;
			if (typeof _config.debounce === 'number') {
				debounce = _config.debounce;
			} else {
				debounce = _config.debounce ? defaultDebounce : 0;
			}

			return { watch, ignore, debounce };

		}
	}

	private startSession(socket: Socket, installAddon: boolean) {

		this.firefoxDebugConnection = new DebugConnection(socket);
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

			if (this.addonPath) {
				switch (this.addonType) {

					case 'legacy':
						if (installAddon) {
							await actors.addons.installAddon(this.addonPath);
						}

						let [addonActor, consoleActor] = await rootActor.fetchProcess();
						this.attachTabOrAddon(addonActor, consoleActor, this.nextTabId++, true, 'Browser');

						break;

					case 'addonSdk':
						if (installAddon) {

							if (this.addonBuildPath) {
								await buildAddonDir(this.addonPath, this.addonBuildPath);
								await actors.addons.installAddon(this.addonBuildPath);
								await actors.preference.setCharPref('vscode.debug.temporaryAddonPath', this.addonBuildPath);
							} else {
								try {
									this.addonBuildPath = await actors.preference.getCharPref('vscode.debug.temporaryAddonPath');
									fs.copySync(this.addonPath, this.addonBuildPath);
								} catch (err) {
								}
							}
						}

						this.fetchAddonsAndAttach(rootActor);

						break;

					case 'webExtension':
						if (installAddon) {
							await actors.addons.installAddon(this.addonPath);
						}

						this.fetchAddonsAndAttach(rootActor);

						break;
				}
			}

			this.reloadTabs = false;
		});

		socket.on('close', () => {
			log.info('Connection to Firefox closed - terminating debug session');
			this.firefoxDebugSocketClosed = true;
			this.sendEvent(new TerminatedEvent());
		});

		if (this.reloadConfig !== undefined) {

			this.reloadWatcher = chokidar.watch(this.reloadConfig.watch, { 
				ignored: this.reloadConfig.ignore,
				ignoreInitial: true
			});

			let reload: () => void;
			if (this.addonId) {

				reload = () => {
					if (this.addonActor !== undefined) {
						log.debug('Reloading add-on');

						if (this.addonPath && this.addonBuildPath) {
							fs.copySync(this.addonPath, this.addonBuildPath);
						}

						this.addonActor.reload();
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

			if (this.reloadConfig.debounce > 0) {
				reload = debounce(reload, this.reloadConfig.debounce);
			}

			this.reloadWatcher.on('add', reload);
			this.reloadWatcher.on('change', reload);
			this.reloadWatcher.on('unlink', reload);
		}

		// now we are ready to accept breakpoints -> fire the initialized event to give UI a chance to set breakpoints
		this.sendEvent(new InitializedEvent());
	}

	private async fetchAddonsAndAttach(rootActor: RootActorProxy): Promise<void> {

		if (this.addonAttached) return;

		let addons = await rootActor.fetchAddons();

		if (this.addonAttached) return;

		addons.forEach((addon) => {
			if (addon.id === this.addonId) {
				(async () => {
					this.addonActor = new TabActorProxy(addon.actor, addon.name, '', this.firefoxDebugConnection);
					let consoleActor = new ConsoleActorProxy(addon.consoleActor, this.firefoxDebugConnection);
					let threadAdapter = await this.attachTabOrAddon(this.addonActor, consoleActor, this.nextTabId++, false, 'Addon');
					if (threadAdapter !== undefined) {
						this.attachConsole(consoleActor, threadAdapter);
					}
					this.addonAttached = true;
				})();
			}
		});
	}

	private async attachTabOrAddon(tabActor: TabActorProxy, consoleActor: ConsoleActorProxy, tabId: number, 
		isTab: boolean, threadName: string): Promise<ThreadAdapter | undefined> {

		let reload = isTab && this.reloadTabs;

		let threadActor: ThreadActorProxy;
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

	private attachConsole(consoleActor: ConsoleActorProxy, threadAdapter: ThreadAdapter): void {

		consoleActor.onConsoleAPICall((consoleEvent) => {
			consoleActorLog.debug(`Console API: ${JSON.stringify(consoleEvent)}`);

			let category = (consoleEvent.level === 'error') ? 'stderr' :
				(consoleEvent.level === 'warn') ? 'console' : 'stdout';

			let outputEvent: DebugProtocol.OutputEvent;
			if ((consoleEvent.arguments.length === 1) && (typeof consoleEvent.arguments[0] !== 'object')) {

				let msg = String(consoleEvent.arguments[0]);
				if (this.showConsoleCallLocation) {
					let filename = this.convertFirefoxUrlToPath(consoleEvent.filename);
					msg += ` (${filename}:${consoleEvent.lineNumber}:${consoleEvent.columnNumber})`;
				}
				outputEvent = new OutputEvent(msg + '\n', category);

			} else {

				let args = consoleEvent.arguments.map((grip, index) =>
					VariableAdapter.fromGrip(String(index), undefined, undefined, grip, true, threadAdapter));

				if (this.showConsoleCallLocation) {
					let filename = this.convertFirefoxUrlToPath(consoleEvent.filename);
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

		let isFirefoxRunning = this.firefoxDebugConnection && !this.firefoxDebugSocketClosed;

		if (isFirefoxRunning) {
			await this.firefoxDebugConnection.disconnect();
		}

		if (this.firefoxProc && isFirefoxRunning) {

			if (this.debugProfileDir) {

				await new Promise<void>((resolve) => {

					this.firefoxProc!.once('exit', async () => {
						try {
							await this.tryRemoveRepeatedly(this.debugProfileDir!);
						} catch (err) {
							log.warn(`Failed to remove temporary profile: ${err}`);
						}
						resolve();
					});

					this.firefoxProc!.kill('SIGTERM');
				});

			} else {
				this.firefoxProc!.kill('SIGTERM');
			}

			this.firefoxProc = undefined;

		} else if (this.debugProfileDir) {

			try {
				await this.tryRemoveRepeatedly(this.debugProfileDir);
			} catch (err) {
				log.warn(`Failed to remove temporary profile: ${err}`);
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
