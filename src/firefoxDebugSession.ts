import * as os from 'os';
import * as path from 'path';
import { connect, Socket } from 'net';
import { ChildProcess } from 'child_process';
import { Log } from './util/log';
import { concatArrays } from './util/misc';
import { findAddonId } from './util/addon';
import { launchFirefox, waitForSocket } from './util/launcher';
import { DebugSession, InitializedEvent, TerminatedEvent, StoppedEvent, OutputEvent, ThreadEvent, BreakpointEvent, ContinuedEvent, Thread, StackFrame, Scope, Variable, Source, Breakpoint } from 'vscode-debugadapter';
import { DebugProtocol } from 'vscode-debugprotocol';
import { DebugConnection, ActorProxy, TabActorProxy, WorkerActorProxy, ThreadActorProxy, ConsoleActorProxy, ExceptionBreakpoints, SourceActorProxy, BreakpointActorProxy, ObjectGripActorProxy, LongStringGripActorProxy } from './firefox/index';
import { ThreadAdapter, BreakpointInfo, BreakpointsAdapter, SourceAdapter, BreakpointAdapter, FrameAdapter, EnvironmentAdapter, VariablesProvider, VariableAdapter, ObjectGripAdapter } from './adapter/index';
import { CommonConfiguration, LaunchConfiguration, AttachConfiguration, AddonType } from './adapter/launchConfiguration';

let log = Log.create('FirefoxDebugSession');
let pathConversionLog = Log.create('PathConversion');
let consoleActorLog = Log.create('ConsoleActor');

export class FirefoxDebugSession extends DebugSession {

	private firefoxProc: ChildProcess = null;
	private firefoxDebugConnection: DebugConnection;

	private pathMappings: [string, string][] = [];
	private addonType: AddonType;
	private addonId: string;
	private addonPath: string;
	private isWindowsPlatform: boolean;

	private nextThreadId = 1;
	private threadsById = new Map<number, ThreadAdapter>();

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

	public convertFirefoxSourceToPath(source: FirefoxDebugProtocol.Source): string {

		if (source.addonID && (source.addonID === this.addonId)) {

			let sourcePath = path.join(this.addonPath, source.addonPath);
			pathConversionLog.debug(`Addon script path: ${sourcePath}`);
			return sourcePath;

		} else if (source.isSourceMapped && source.generatedUrl && !this.urlDetector.test(source.url)) {

			let generatedPath = this.convertFirefoxUrlToPath(source.generatedUrl);
			if (!generatedPath) return null;

			let relativePath = source.url;

			let sourcePath = path.resolve(path.dirname(generatedPath), relativePath);
			pathConversionLog.debug(`Sourcemapped path: ${sourcePath}`);
			return sourcePath;

		} else if ((this.addonType === 'webExtension') && (source.url.substr(0, 16) === 'moz-extension://')) {

			let sourcePath = this.addonPath + source.url.substr(source.url.indexOf('/', 16));
			pathConversionLog.debug(`WebExtension script path: ${sourcePath}`);
			return sourcePath;

		} else {
			return this.convertFirefoxUrlToPath(source.url);
		}
	}

	private urlDetector = /^[a-zA-Z][a-zA-Z0-9\+\-\.]*\:\/\//;

	private convertFirefoxUrlToPath(url: string): string {
		if (!url) return null;

		for (var i = 0; i < this.pathMappings.length; i++) {

			let [from, to] = this.pathMappings[i];

			if (url.substr(0, from.length) === from) {

				let path = to + url.substr(from.length);
				if (this.isWindowsPlatform) {
					path = path.replace(/\//g, '\\');
				}

				pathConversionLog.debug(`Converted url ${url} to path ${path}`);
				return path;
			}
		}

		pathConversionLog.warn(`Can't convert url ${url} to path`);
		return null;
	}

	protected initializeRequest(response: DebugProtocol.InitializeResponse, args: DebugProtocol.InitializeRequestArguments): void {
		response.body = {
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
		this.sendResponse(response);
	}

	protected launchRequest(response: DebugProtocol.LaunchResponse, args: LaunchConfiguration): void {

		let configError = this.readCommonConfiguration(args);
		if (configError) {
			response.success = false;
			response.message = configError;
			this.sendResponse(response);
			return;
		}

		launchFirefox(args, this.addonId).then((launchResult) => {

			this.firefoxProc = launchResult;

			waitForSocket(args).then(
				(socket) => {
					this.startSession(socket);
					this.sendResponse(response);
				},
				(err) => {
					log.error('Error: ' + err);
					response.success = false;
					response.message = String(err);
					this.sendResponse(response);
				}
			);
		},
		(err) => {
			response.success = false;
			response.message = String(err);
			this.sendResponse(response);
		});
	}

	protected attachRequest(response: DebugProtocol.AttachResponse, args: AttachConfiguration): void {

		let configError = this.readCommonConfiguration(args);
		if (configError) {
			response.success = false;
			response.message = configError;
			this.sendResponse(response);
			return;
		}

		let socket = connect(args.port || 6000, args.host || 'localhost');
		this.startSession(socket);

		socket.on('connect', () => {
			this.sendResponse(response);
		});

		socket.on('error', (err) => {
			response.success = false;
			response.message = String(err);
			this.sendResponse(response);
		});
	}

	private readCommonConfiguration(args: CommonConfiguration): string {

		if (args.log) {
			Log.config = args.log;
		}

		if (args.addonType) {

			if (!args.addonPath) {
				return `If you set "addonType" you also have to set "addonPath" in the ${args.request} configuration`;
			}

			this.addonType = args.addonType;

			let success: boolean;
			let addonIdOrErrorMsg: string;
			[success, addonIdOrErrorMsg] = findAddonId(args.addonType, args.addonPath);
			if (success) {
				this.addonId = addonIdOrErrorMsg;
				this.addonPath = args.addonPath;
			} else {
				return addonIdOrErrorMsg;
			}

		} else if (args.addonPath) {

			return `If you set "addonPath" you also have to set "addonType" in the ${args.request} configuration`;

		} else if (args.url) {

			if (!args.webRoot) {
				return `If you set "url" you also have to set "webRoot" in the ${args.request} configuration`;
			} else if (!path.isAbsolute(args.webRoot)) {
				return `The "webRoot" property in the ${args.request} configuration has to be an absolute path`;
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

			this.pathMappings.push([webRootUrl, webRoot]);

		} else if (args.webRoot) {

			return `If you set "webRoot" you also have to set "url" in the ${args.request} configuration`;

		}

		this.pathMappings.push([(this.isWindowsPlatform ? 'file:///' : 'file://'), '']);

		pathConversionLog.debug('Path mappings:');
		this.pathMappings.forEach(([from, to]) => pathConversionLog.debug(`'${from}' => '${to}'`));
	}

	private startSession(socket: Socket) {

		this.firefoxDebugConnection = new DebugConnection(socket);
		let rootActor = this.firefoxDebugConnection.rootActor;

		let nextTabId = 1;

		if (this.addonId) {
			// attach to Firefox addon
			rootActor.onInit(() => {

				rootActor.fetchAddons().then((addons) => {
					addons.forEach((addon) => {
						if (addon.id === this.addonId) {
							this.attachTab(
								new TabActorProxy(addon.actor, addon.name, '', this.firefoxDebugConnection),
								new ConsoleActorProxy(addon.consoleActor, this.firefoxDebugConnection),
								nextTabId++, 'Addon');
						}
					});
				});

				if (this.addonType === 'legacy') {
					rootActor.fetchProcess().then(([tabActor, consoleActor]) => {
						this.attachTab(tabActor, consoleActor, nextTabId++, 'Browser');
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

		// now we are ready to accept breakpoints -> fire the initialized event to give UI a chance to set breakpoints
		this.sendEvent(new InitializedEvent());
	}

	private attachTab(tabActor: TabActorProxy, consoleActor: ConsoleActorProxy, tabId: number, threadName?: string): void {
		tabActor.attach().then(
			(threadActor) => {
				log.debug(`Attached to tab ${tabActor.name}`);

				let threadId = this.nextThreadId++;
				if (!threadName) {
					threadName = `Tab ${tabId}`;
				}
				let threadAdapter = new ThreadAdapter(threadId, threadActor, consoleActor, threadName, this);

				this.attachThread(threadActor, threadAdapter);

				threadAdapter.init(this.exceptionBreakpoints).then(
					() => {
						this.threadsById.set(threadId, threadAdapter);
						this.sendEvent(new ThreadEvent('started', threadId));

						tabActor.onDetached(() => {
							this.threadsById.delete(threadId);
							this.sendEvent(new ThreadEvent('exited', threadId));
						});
					},
					(err) => {
						// When the user closes a tab, Firefox creates an invisible tab and
						// immediately closes it again (while we're still trying to attach to it),
						// so the initialization for this invisible tab fails and we end up here.
						// Since we never sent the current threadId to VSCode, we can re-use it
						if (this.nextThreadId == (threadId + 1)) {
							this.nextThreadId--;
						}
					}
				);

				let nextWorkerId = 1;
				tabActor.onWorkerStarted((workerActor) => {
					log.info(`Worker started with url ${tabActor.url}`);
					let workerId = nextWorkerId++;
					this.attachWorker(workerActor, tabId, workerId);
				});
				tabActor.onWorkerListChanged(() => tabActor.fetchWorkers());
				tabActor.fetchWorkers();
			},

			(err) => {
				log.error(`Failed attaching to tab: ${err}`);
			});
	}

	private attachWorker(workerActor: WorkerActorProxy, tabId: number, workerId: number): void {
		workerActor.attach().then((url) => workerActor.connect()).then(
			(threadActor) => {
				log.debug(`Attached to worker ${workerActor.name}`);

				let threadId = this.nextThreadId++;
				let threadAdapter = new ThreadAdapter(threadId, threadActor, null,
					`Worker ${tabId}/${workerId}`, this);

				this.attachThread(threadActor, threadAdapter);

				threadAdapter.init(this.exceptionBreakpoints).then(
					() => {
						this.threadsById.set(threadId, threadAdapter);
						this.sendEvent(new ThreadEvent('started', threadId));

						workerActor.onClose(() => {
							this.threadsById.delete(threadId);
							this.sendEvent(new ThreadEvent('exited', threadId));
						});
					},
					(err) => {
						log.error('Failed initializing worker thread');
					}
				);
			},

			(err) => {
				log.error(`Failed attaching to worker: ${err}`);
			});
	}

	private attachThread(threadActor: ThreadActorProxy, threadAdapter: ThreadAdapter): void {

		threadActor.onNewSource((sourceActor) => {
			pathConversionLog.debug(`New source ${sourceActor.url} in thread ${threadActor.name}`);
			this.attachSource(sourceActor, threadAdapter);
		});

		threadActor.onPaused((reason) => {
			log.info(`Thread ${threadActor.name} paused , reason: ${reason.type}`);
			let stoppedEvent = new StoppedEvent(reason.type, threadAdapter.id);
			(<DebugProtocol.StoppedEvent>stoppedEvent).body.allThreadsStopped = false;
			this.sendEvent(stoppedEvent);
		});

		threadActor.onResumed(() => {
			log.info(`Thread ${threadActor.name} resumed unexpectedly`);
			this.sendEvent(new ContinuedEvent(threadAdapter.id));
		});

		threadActor.onExited(() => {
			log.info(`Thread ${threadActor.name} exited`);
			this.threadsById.delete(threadAdapter.id);
			this.sendEvent(new ThreadEvent('exited', threadAdapter.id));
		});
	}

	private attachSource(sourceActor: SourceActorProxy, threadAdapter: ThreadAdapter): void {

		let sourcePath = this.convertFirefoxSourceToPath(sourceActor.source);
		let sourceAdapters = threadAdapter.findSourceAdaptersForPath(sourcePath);

		if (sourceAdapters.length > 0) {

			sourceAdapters.forEach((sourceAdapter) => sourceAdapter.actor = sourceActor);

		} else {

			let sourceId = this.nextSourceId++;
			let sourceAdapter = threadAdapter.createSourceAdapter(sourceId, sourceActor, sourcePath);
			this.sourcesById.set(sourceId, sourceAdapter);
			sourceAdapters.push(sourceAdapter);

		}

		if (this.breakpointsBySourcePath.has(sourcePath)) {

			let breakpointInfos = this.breakpointsBySourcePath.get(sourcePath);

			sourceAdapters.forEach((sourceAdapter) => {

				let setBreakpointsPromise = threadAdapter.setBreakpoints(
					breakpointInfos, sourceAdapter);

				if (this.verifiedBreakpointSources.indexOf(sourceActor.url) < 0) {

					setBreakpointsPromise.then((breakpointAdapters) => {

						log.debug('Updating breakpoints');

						breakpointAdapters.forEach((breakpointAdapter) => {
							let breakpoint: DebugProtocol.Breakpoint =
								new Breakpoint(true, breakpointAdapter.breakpointInfo.actualLine);
							breakpoint.id = breakpointAdapter.breakpointInfo.id;
							this.sendEvent(new BreakpointEvent('update', breakpoint));
						})

						this.verifiedBreakpointSources.push(sourceActor.url);
					})
				}
			});
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

	protected threadsRequest(response: DebugProtocol.ThreadsResponse): void {
		log.debug(`Received threadsRequest - replying with ${this.threadsById.size} threads`);

		let responseThreads: Thread[] = [];
		this.threadsById.forEach((threadAdapter) => {
			responseThreads.push(new Thread(threadAdapter.id, threadAdapter.name));
		});
		response.body = { threads: responseThreads };

		this.sendResponse(response);
	}

    protected setBreakPointsRequest(response: DebugProtocol.SetBreakpointsResponse, args: DebugProtocol.SetBreakpointsArguments): void {
		log.debug(`Received setBreakpointsRequest with ${args.breakpoints.length} breakpoints for ${args.source.path}`);

		let sourcePath = args.source.path;
		let breakpointInfos = args.breakpoints.map((breakpoint) => <BreakpointInfo>{
			id: this.nextBreakpointId++,
			requestedLine: breakpoint.line,
			condition: breakpoint.condition
		});

		this.breakpointsBySourcePath.set(sourcePath, breakpointInfos);
		this.verifiedBreakpointSources = this.verifiedBreakpointSources.filter(
			(verifiedSourcePath) => (verifiedSourcePath !== sourcePath));

		this.threadsById.forEach((threadAdapter) => {

			let sourceAdapters = threadAdapter.findSourceAdaptersForPath(sourcePath);
			sourceAdapters.forEach((sourceAdapter) => {

				log.debug(`Found source ${args.source.path} on tab ${threadAdapter.actorName}`);

				let setBreakpointsPromise = threadAdapter.setBreakpoints(breakpointInfos, sourceAdapter);

				if (this.verifiedBreakpointSources.indexOf(sourcePath) < 0) {

					setBreakpointsPromise.then(
						(breakpointAdapters) => {

							response.body = {
								breakpoints: breakpointAdapters.map(
									(breakpointAdapter) => {
										let breakpoint: DebugProtocol.Breakpoint =
											new Breakpoint(true, breakpointAdapter.breakpointInfo.actualLine);
										breakpoint.id = breakpointAdapter.breakpointInfo.id;
										return breakpoint;
									})
							};

							log.debug('Replying to setBreakpointsRequest with actual breakpoints from the first thread with this source');
							this.sendResponse(response);

						},
						(err) => {
							log.error(`Failed setBreakpointsRequest: ${err}`);
							response.success = false;
							response.message = String(err);
							this.sendResponse(response);
						});

					this.verifiedBreakpointSources.push(sourcePath);
				}
			});
		});

		if (this.verifiedBreakpointSources.indexOf(sourcePath) < 0) {
			log.debug (`Replying to setBreakpointsRequest (Source ${args.source.path} not seen yet)`);

			response.body = {
				breakpoints: breakpointInfos.map((breakpointInfo) => {
					let breakpoint: DebugProtocol.Breakpoint =
						new Breakpoint(false, breakpointInfo.requestedLine);
					breakpoint.id = breakpointInfo.id;
					return breakpoint;
				})
			};

			this.sendResponse(response);
		}
	}

	protected setExceptionBreakPointsRequest(response: DebugProtocol.SetExceptionBreakpointsResponse, args: DebugProtocol.SetExceptionBreakpointsArguments): void {
		log.debug(`Received setExceptionBreakPointsRequest with filters: ${JSON.stringify(args.filters)}`);

		this.exceptionBreakpoints = ExceptionBreakpoints.None;

		if (args.filters.indexOf('all') >= 0) {
			this.exceptionBreakpoints = ExceptionBreakpoints.All;
		} else if (args.filters.indexOf('uncaught') >= 0) {
			this.exceptionBreakpoints = ExceptionBreakpoints.Uncaught;
		}

		this.threadsById.forEach((threadAdapter) =>
			threadAdapter.setExceptionBreakpoints(this.exceptionBreakpoints));

		this.sendResponse(response);
	}

	protected pauseRequest(response: DebugProtocol.PauseResponse, args: DebugProtocol.PauseArguments): void {
		log.debug('Received pauseRequest');
		let threadId = args.threadId ? args.threadId : 1;
		let threadAdapter = this.threadsById.get(threadId);
		threadAdapter.interrupt().then(
			() => {
				log.debug('Replying to pauseRequest');
				this.sendResponse(response);
				let stoppedEvent = new StoppedEvent('interrupt', threadId);
				(<DebugProtocol.StoppedEvent>stoppedEvent).body.allThreadsStopped = false;
				this.sendEvent(stoppedEvent);
			},
			(err) => {
				log.error('Failed pauseRequest: ' + err);
				response.success = false;
				response.message = String(err);
				this.sendResponse(response);
			});
	}

	protected continueRequest(response: DebugProtocol.ContinueResponse, args: DebugProtocol.ContinueArguments): void {
		log.debug('Received continueRequest');
		let threadAdapter = this.threadsById.get(args.threadId);
		threadAdapter.resume().then(
			() => {
				log.debug('Replying to continueRequest');
				response.body = { allThreadsContinued: false };
				this.sendResponse(response);
			},
			(err) => {
				log.error('Failed continueRequest: ' + err);
				response.success = false;
				response.message = String(err);
				this.sendResponse(response);
			});
	}

	protected nextRequest(response: DebugProtocol.NextResponse, args: DebugProtocol.NextArguments): void {
		log.debug('Received nextRequest');
		let threadAdapter = this.threadsById.get(args.threadId);
		threadAdapter.stepOver().then(
			() => {
				log.debug('Replying to nextRequest');
				this.sendResponse(response);
			},
			(err) => {
				log.error('Failed nextRequest: ' + err);
				response.success = false;
				response.message = String(err);
				this.sendResponse(response);
			});
	}

	protected stepInRequest(response: DebugProtocol.StepInResponse, args: DebugProtocol.StepInArguments): void {
		log.debug('Received stepInRequest');
		let threadAdapter = this.threadsById.get(args.threadId);
		threadAdapter.stepIn().then(
			() => {
				log.debug('Replying to stepInRequest');
				this.sendResponse(response);
			},
			(err) => {
				log.error('Failed stepInRequest: ' + err);
				response.success = false;
				response.message = String(err);
				this.sendResponse(response);
			});
	}

	protected stepOutRequest(response: DebugProtocol.StepOutResponse, args: DebugProtocol.StepOutArguments): void {
		log.debug('Received stepOutRequest');
		let threadAdapter = this.threadsById.get(args.threadId);
		threadAdapter.stepOut().then(
			() => {
				log.debug('Replying to stepOutRequest');
				this.sendResponse(response);
			},
			(err) => {
				log.error('Failed stepOutRequest: ' + err);
				response.success = false;
				response.message = String(err);
				this.sendResponse(response);
			});
	}

	protected stackTraceRequest(response: DebugProtocol.StackTraceResponse, args: DebugProtocol.StackTraceArguments): void {
		let threadAdapter = this.threadsById.get(args.threadId);
		log.debug(`Received stackTraceRequest for ${threadAdapter.actorName}`);

		threadAdapter.fetchStackFrames(args.startFrame || 0, args.levels || 0).then(
			([frameAdapters, totalFrameCount]) => {

				log.debug('Replying to stackTraceRequest');
				response.body = {
					stackFrames: frameAdapters.map((frameAdapter) => frameAdapter.getStackframe()),
					totalFrames: totalFrameCount
				};
				this.sendResponse(response);

			},
			(err) => {
				log.error(`Failed stackTraceRequest: ${err}`);
				response.success = false;
				response.message = String(err);
				this.sendResponse(response);
			});
	}

	protected scopesRequest(response: DebugProtocol.ScopesResponse, args: DebugProtocol.ScopesArguments): void {
		log.debug('Received scopesRequest');

		let frameAdapter = this.framesById.get(args.frameId);
		if (frameAdapter === undefined) {
			let err = 'Failed scopesRequest: the requested frame can\'t be found';
			log.error(err);
			response.success = false;
			response.message = err;
			this.sendResponse(response);
			return;
		}

		log.debug('Replying to scopesRequest');
		response.body = { scopes: frameAdapter.scopeAdapters.map((scopeAdapter) => scopeAdapter.getScope()) };
		this.sendResponse(response);
	}

	protected variablesRequest(response: DebugProtocol.VariablesResponse, args: DebugProtocol.VariablesArguments): void {
		log.debug('Received variablesRequest');

		let variablesProvider = this.variablesProvidersById.get(args.variablesReference);
		if (variablesProvider === undefined) {
			let err = 'Failed variablesRequest: the requested object reference can\'t be found';
			log.error(err);
			response.success = false;
			response.message = err;
			this.sendResponse(response);
			return;
		}

		variablesProvider.threadAdapter.fetchVariables(variablesProvider).then(
			(variables) => {

				log.debug('Replying to variablesRequest');
				response.body = { variables };
				this.sendResponse(response);

			},
			(err) => {
				log.error(`Failed variablesRequest: ${err}`);
				response.success = false;
				response.message = String(err);
				this.sendResponse(response);
			}
		);
	}

	protected evaluateRequest(response: DebugProtocol.EvaluateResponse, args: DebugProtocol.EvaluateArguments): void {
		log.debug('Received evaluateRequest');

		let threadAdapter: ThreadAdapter;
		let frameActorName: string;
		if (args.frameId) {
			let frameAdapter = this.framesById.get(args.frameId);
			threadAdapter = frameAdapter.threadAdapter;
			frameActorName = frameAdapter.frame.actor;
		} else {
			threadAdapter = this.threadsById.get(1);
		}
		
		threadAdapter.evaluate(
			args.expression, frameActorName, (args.context !== 'watch')).then(

			(variable) => {

				log.debug('Replying to evaluateRequest');
				response.body = {
					result: variable.value,
					variablesReference: variable.variablesReference
				};
				this.sendResponse(response);

			},
			(err) => {
				log.error(`Failed evaluateRequest for "${args.expression}": ${err}`);
				response.success = false;
				response.message = String(err);
				this.sendResponse(response);
			});
	}

	protected sourceRequest(response: DebugProtocol.SourceResponse, args: DebugProtocol.SourceArguments): void {
		log.debug('Received sourceRequest');

		let sourceAdapter = this.sourcesById.get(args.sourceReference);
		sourceAdapter.actor.fetchSource().then(
			(sourceGrip) => {

				if (typeof sourceGrip === 'string') {

					response.body = { content: sourceGrip };
					this.sendResponse(response);

				} else {

					let longStringGrip = <FirefoxDebugProtocol.LongStringGrip>sourceGrip;
					let longStringActor = this.getOrCreateLongStringGripActorProxy(longStringGrip);
					longStringActor.fetchContent().then(
						(content) => {

							log.debug('Replying to sourceRequest');
							response.body = { content };
							this.sendResponse(response);

						},
						(err) => {
							log.error(`Failed sourceRequest: ${err}`);
							response.success = false;
							response.message = String(err);
							this.sendResponse(response);
						});
				}
			},
			(err) => {
				log.error(`Failed sourceRequest: ${err}`);
				response.success = false;
				response.message = String(err);
				this.sendResponse(response);
			});
	}

	protected disconnectRequest(response: DebugProtocol.DisconnectResponse, args: DebugProtocol.DisconnectArguments): void {
		log.debug('Received disconnectRequest');

		let detachPromises: Promise<void>[] = [];
		this.threadsById.forEach((threadAdapter) => {
			detachPromises.push(threadAdapter.detach());
		});

		Promise.all(detachPromises).then(
			() => {
				log.debug('Replying to disconnectRequest');
				this.disconnect();
				this.sendResponse(response);
			},
			(err) => {
				log.warn(`Failed disconnectRequest: ${err}`);
				this.disconnect();
				this.sendResponse(response);
			});
	}

	private disconnect() {
		if (this.firefoxDebugConnection) {
			this.firefoxDebugConnection.disconnect().then(() => {
				if (this.firefoxProc) {
					this.firefoxProc.kill('SIGTERM');
					this.firefoxProc = null;
				}
			});
		}
	}
}

DebugSession.run(FirefoxDebugSession);
