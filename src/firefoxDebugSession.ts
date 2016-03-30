import { platform } from 'os';
import { connect, Socket } from 'net';
import { ChildProcess } from 'child_process';
import { Log } from './util/log';
import { concatArrays } from './util/misc';
import { launchFirefox, waitForSocket } from './util/launcher';
import { DebugSession, InitializedEvent, TerminatedEvent, StoppedEvent, OutputEvent, ThreadEvent, BreakpointEvent, Thread, StackFrame, Scope, Variable, Source, Breakpoint } from 'vscode-debugadapter';
import { DebugProtocol } from 'vscode-debugprotocol';
import { DebugConnection, ActorProxy, TabActorProxy, ThreadActorProxy, ExceptionBreakpoints, SourceActorProxy, BreakpointActorProxy, ObjectGripActorProxy, LongStringGripActorProxy } from './firefox/index';
import { ThreadAdapter, BreakpointInfo, BreakpointsAdapter, SourceAdapter, BreakpointAdapter, FrameAdapter, EnvironmentAdapter, VariablesProvider, VariableAdapter, ObjectGripAdapter } from './adapter/index';
import { WebRootConfiguration, LaunchConfiguration, AttachConfiguration } from './adapter/launchConfiguration';

let log = Log.create('FirefoxDebugSession');

export class FirefoxDebugSession extends DebugSession {

	private firefoxProc: ChildProcess = null;
	private firefoxDebugConnection: DebugConnection;

	private webRootUrl: string;
	private webRoot: string;
	private isWindowsPlatform: boolean;
	
	private nextThreadId = 1;
	private threadsById = new Map<number, ThreadAdapter>();
	
	private nextBreakpointId = 1;
	private breakpointsBySourceUrl = new Map<string, BreakpointInfo[]>();
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

		this.isWindowsPlatform = (platform() === 'win32');
		
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

	public convertPathToFirefoxUrl(path: string): string {
		if (this.isWindowsPlatform) {
			path = path.replace(/\\/g, '/');
		}
		if (this.webRoot) {
			if (path.substr(0, this.webRoot.length) === this.webRoot) {
				return this.webRootUrl + path.substr(this.webRoot.length);
			} else {
				log.warn(`Can't convert path ${path} to url`);
				return null;
			}
		} else {
			return (this.isWindowsPlatform ? 'file:///' : 'file://') + path;
		}
	}
	
	public convertFirefoxUrlToPath(url: string): string {
		if (this.webRootUrl && (url.substr(0, this.webRootUrl.length) === this.webRootUrl)) {
			url = this.webRoot + url.substr(this.webRootUrl.length);
		} else if (url.substr(0, 7) === 'file://') {
			url = url.substr(this.isWindowsPlatform ? 8 : 7);
		} else {
			log.warn(`Can't convert url ${url} to local path`);
			return null;
		}
		if (this.isWindowsPlatform) {
			url = url.replace(/\//g, '\\');
		}
		return url;
	}
	
	protected initializeRequest(response: DebugProtocol.InitializeResponse, args: DebugProtocol.InitializeRequestArguments): void {
		response.body = {
			supportsConfigurationDoneRequest: false,
			supportsEvaluateForHovers: false,
			supportsFunctionBreakpoints: false,
			supportsConditionalBreakpoints: true
		};
		this.sendResponse(response);
	}
	
    protected launchRequest(response: DebugProtocol.LaunchResponse, args: LaunchConfiguration): void {

		this.readWebRootConfiguration(args);
		
		this.firefoxProc = launchFirefox(args, (path) => this.convertPathToFirefoxUrl(path));

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
	}

    protected attachRequest(response: DebugProtocol.AttachResponse, args: AttachConfiguration): void {

		this.readWebRootConfiguration(args);
		
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
	
	private readWebRootConfiguration(args: WebRootConfiguration) {
		if (args.url) {
			this.webRootUrl = args.url;
			if (this.webRootUrl.indexOf('/') >= 0) {
				this.webRootUrl = this.webRootUrl.substr(0, this.webRootUrl.lastIndexOf('/'));
			}
			this.webRoot = args.webRoot;
			if (this.isWindowsPlatform) {
				this.webRoot = this.webRoot.replace(/\\/g, '/');
			}
		}
	}
	
	private startSession(socket: Socket) {
		
		this.firefoxDebugConnection = new DebugConnection(socket);

		// attach to all tabs, register the corresponding threads and inform VSCode about them
		this.firefoxDebugConnection.rootActor.onTabOpened((tabActor) => {
			
			log.info(`Tab opened with url ${tabActor.url}`);
			
			tabActor.attach().then((threadActor) => {

				log.debug(`Attached to tab ${tabActor.name}`);

				let threadId = this.nextThreadId++;
				let threadAdapter = new ThreadAdapter(threadId, threadActor, this);
				this.threadsById.set(threadId, threadAdapter);


				threadActor.onNewSource((sourceActor) => {

					log.debug(`New source ${sourceActor.url} in tab ${tabActor.name}`);

					let sourceId = this.nextSourceId++;
					let sourceAdapter = threadAdapter.createSourceAdapter(sourceId, sourceActor);
					this.sourcesById.set(sourceId, sourceAdapter);

					if (this.breakpointsBySourceUrl.has(sourceActor.url)) {
						
						let breakpointInfos = this.breakpointsBySourceUrl.get(sourceActor.url);
						let setBreakpointsPromise = BreakpointsAdapter.setBreakpointsOnSourceActor(
							breakpointInfos, sourceAdapter, threadActor);
						
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
						
					}
				});
				

				threadActor.onPaused((why) => {

					log.info(`Thread ${threadActor.name} paused , reason: ${why}`);

					this.sendEvent(new StoppedEvent(why, threadId));
				});
				

				threadActor.onExited(() => {

					log.info(`Thread ${threadActor.name} exited`);

					this.threadsById.delete(threadId);

					this.sendEvent(new ThreadEvent('exited', threadId));
				});
				
				threadActor.setExceptionBreakpoints(this.exceptionBreakpoints);
				threadActor.resume();

				this.sendEvent(new ThreadEvent('started', threadId));
			},
			(err) => {
				log.error(`Failed attaching to tab/thread: ${err}`);
			});
		});

		let rootActor = this.firefoxDebugConnection.rootActor;
		rootActor.onTabListChanged(() => {
			rootActor.fetchTabs();
		});
		rootActor.onInit(() => {
			rootActor.fetchTabs();
		});
		
		// now we are ready to accept breakpoints -> fire the initialized event to give UI a chance to set breakpoints
		this.sendEvent(new InitializedEvent());
	}

	protected threadsRequest(response: DebugProtocol.ThreadsResponse): void {

		log.debug(`Received threadsRequest - replying with ${this.threadsById.size} threads`);
		
		let responseThreads: Thread[] = [];
		this.threadsById.forEach((threadAdapter) => {
			responseThreads.push(new Thread(threadAdapter.id, threadAdapter.actor.name));
		});
		response.body = { threads: responseThreads };
		
		this.sendResponse(response);
	}
	
    protected setBreakPointsRequest(response: DebugProtocol.SetBreakpointsResponse, args: DebugProtocol.SetBreakpointsArguments): void {

		log.debug(`Received setBreakpointsRequest with ${args.breakpoints.length} breakpoints for ${args.source.path}`);

		let firefoxSourceUrl = this.convertPathToFirefoxUrl(args.source.path);
		let breakpointInfos = args.breakpoints.map((breakpoint) => <BreakpointInfo>{ 
			id: this.nextBreakpointId++, 
			requestedLine: breakpoint.line,
			condition: breakpoint.condition 
		});

		this.breakpointsBySourceUrl.set(firefoxSourceUrl, breakpointInfos);
		this.verifiedBreakpointSources = 
			this.verifiedBreakpointSources.filter((sourceUrl) => (sourceUrl !== firefoxSourceUrl));
		
		this.threadsById.forEach((threadAdapter) => {
			
			let sourceAdapter = threadAdapter.findSourceAdapterForUrl(firefoxSourceUrl);
			if (sourceAdapter !== null) {

				log.debug(`Found source ${args.source.path} on tab ${threadAdapter.actor.name}`);
				
				let setBreakpointsPromise = BreakpointsAdapter.setBreakpointsOnSourceActor(
					breakpointInfos, sourceAdapter, threadAdapter.actor);
				
				if (this.verifiedBreakpointSources.indexOf(firefoxSourceUrl) < 0) {

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
							log.error(`Failed setting breakpoints: ${err}`);
							response.success = false;
							response.message = String(err);
							this.sendResponse(response);
						});
						
					this.verifiedBreakpointSources.push(firefoxSourceUrl);
				}
			}
		});
		
		if (this.verifiedBreakpointSources.indexOf(firefoxSourceUrl) < 0) {

			log.debug (`Source ${args.source.path} not seen yet`);

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
		
		this.exceptionBreakpoints = ExceptionBreakpoints.None;
		
		if (args.filters.indexOf('all') >= 0) {
			this.exceptionBreakpoints = ExceptionBreakpoints.All;
		} else if (args.filters.indexOf('uncaught') >= 0) {
			this.exceptionBreakpoints = ExceptionBreakpoints.Uncaught;
		}
		
		this.threadsById.forEach((threadAdapter) => 
			threadAdapter.actor.setExceptionBreakpoints(this.exceptionBreakpoints));

		this.sendResponse(response);			
	}

	protected pauseRequest(response: DebugProtocol.PauseResponse, args: DebugProtocol.PauseArguments): void {
		log.debug('Received pauseRequest');
		this.threadsById.get(args.threadId).actor.interrupt();
		this.sendResponse(response);
	}
	
	protected continueRequest(response: DebugProtocol.ContinueResponse, args: DebugProtocol.ContinueArguments): void {
		log.debug('Received continueRequest');
		let threadAdapter = this.threadsById.get(args.threadId);
		threadAdapter.disposePauseLifetimeAdapters();
		threadAdapter.actor.resume();
		this.sendResponse(response);
	}

	protected nextRequest(response: DebugProtocol.NextResponse, args: DebugProtocol.NextArguments): void {
		log.debug('Received nextRequest');
		let threadAdapter = this.threadsById.get(args.threadId);
		threadAdapter.disposePauseLifetimeAdapters();
		threadAdapter.actor.stepOver();
		this.sendResponse(response);
	}

	protected stepInRequest(response: DebugProtocol.StepInResponse, args: DebugProtocol.StepInArguments): void {
		log.debug('Received stepInRequest');
		let threadAdapter = this.threadsById.get(args.threadId);
		threadAdapter.disposePauseLifetimeAdapters();
		threadAdapter.actor.stepInto();
		this.sendResponse(response);
	}

	protected stepOutRequest(response: DebugProtocol.StepOutResponse, args: DebugProtocol.StepOutArguments): void {
		log.debug('Received stepOutRequest');
		let threadAdapter = this.threadsById.get(args.threadId);
		threadAdapter.disposePauseLifetimeAdapters();
		threadAdapter.actor.stepOut();
		this.sendResponse(response);
	}
	
	protected stackTraceRequest(response: DebugProtocol.StackTraceResponse, args: DebugProtocol.StackTraceArguments): void {

		let threadAdapter = this.threadsById.get(args.threadId);

		log.debug(`Received stackTraceRequest for ${threadAdapter.actor.name}`);

		threadAdapter.actor.runOnPausedThread((finished) => {
			threadAdapter.fetchStackFrames(args.levels).then(
				(frameAdapters) => {

					response.body = { stackFrames: frameAdapters.map(
						(frameAdapter) => frameAdapter.getStackframe()) };
					this.sendResponse(response);

					let objectGripAdapters = concatArrays(frameAdapters.map(
						(frameAdapter) => frameAdapter.getObjectGripAdapters()));
					
					let extendLifetimePromises = objectGripAdapters.map(
						(objectGripAdapter) => objectGripAdapter.actor.extendLifetime());
					
					Promise.all(extendLifetimePromises).then(() => finished());
					
				},
				(err) => {
					log.error(`Failed fetching stackframes: ${err}`);
					response.success = false;
					response.message = String(err);
					this.sendResponse(response);
					finished();
				});
		});
	}
	
	protected scopesRequest(response: DebugProtocol.ScopesResponse, args: DebugProtocol.ScopesArguments): void {

		log.debug('Received scopesRequest');
		
		let frameAdapter = this.framesById.get(args.frameId);
		if (frameAdapter === undefined) {
			let err = 'scopesRequest failed because the requested frame can\'t be found';
			log.error(err);
			response.success = false;
			response.message = err;
			this.sendResponse(response);
			return;
		}
		
		response.body = { scopes: frameAdapter.scopeAdapters.map((scopeAdapter) => scopeAdapter.getScope()) };
		
		this.sendResponse(response);
	}
	
	protected variablesRequest(response: DebugProtocol.VariablesResponse, args: DebugProtocol.VariablesArguments): void {

		log.debug('Received variablesRequest');
		
		let variablesProvider = this.variablesProvidersById.get(args.variablesReference);
		if (variablesProvider === undefined) {
			let err = 'variablesRequest failed because the requested object reference can\'t be found';
			log.error(err);
			response.success = false;
			response.message = err;
			this.sendResponse(response);
			return;
		}
		
		variablesProvider.threadAdapter.actor.runOnPausedThread((finished) => {
			variablesProvider.getVariables().then(
				(variableAdapters) => {
					
					response.body = { variables: variableAdapters.map(
						(variableAdapter) => variableAdapter.getVariable()) };
					this.sendResponse(response);
					
					let objectGripAdapters = variableAdapters
						.map((variableAdapter) => variableAdapter.getObjectGripAdapter())
						.filter((objectGripAdapter) => (objectGripAdapter != null));
					
					let extendLifetimePromises = objectGripAdapters.map(
						(objectGripAdapter) => objectGripAdapter.actor.extendLifetime());
					
					Promise.all(extendLifetimePromises).then(() => finished());
					
				},
				(err) => {
					response.success = false;
					response.message = String(err);
					this.sendResponse(response);
					finished();
				});
		});
	}
	
	protected evaluateRequest(response: DebugProtocol.EvaluateResponse, args: DebugProtocol.EvaluateArguments): void {
		
		log.debug('Received evaluateRequest');
		
		if (args.frameId !== undefined) {
			
			let frameAdapter = this.framesById.get(args.frameId);

			frameAdapter.threadAdapter.actor.runOnPausedThread((finished) => {
				frameAdapter.evaluate(args.expression).then(
					(grip) => {

						if (grip !== undefined) {
							
							let variableAdapter = VariableAdapter.fromGrip(
								'', grip, (args.context !== 'watch'), frameAdapter.threadAdapter);
							
							let variable = variableAdapter.getVariable();
							response.body = { 
								result: variable.value, 
								variablesReference: variable.variablesReference
							};
							this.sendResponse(response);

							let objectGripAdapter = variableAdapter.getObjectGripAdapter();
							if (objectGripAdapter != null) {
								objectGripAdapter.actor.extendLifetime().then(() => finished());
							} else {
								finished();
							}
							
						} else {

							response.body = { 
								result: 'undefined',
								variablesReference: undefined
							};
							this.sendResponse(response);
							finished();
							
						}
					},
					(err) => {
						log.error(`Failed evaluating "${args.expression}": ${err}`);
						response.success = false;
						response.message = String(err);
						this.sendResponse(response);
						finished();
					});
			});
			
		} else {
			log.error(`Failed evaluating "${args.expression}": Can't find requested evaluation frame`);
			response.success = false;
			response.message = 'Can\'t find requested evaluation frame';
			this.sendResponse(response);
		}
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
							
							response.body = { content };
							this.sendResponse(response);
							
						},
						(err) => {
							log.error(`Failed fetching source: ${err}`);
							response.success = false;
							response.message = String(err);
							this.sendResponse(response);
						});
				}
			},
			(err) => {
				log.error(`Failed fetching source: ${err}`);
				response.success = false;
				response.message = String(err);
				this.sendResponse(response);
			});
	}	

	protected disconnectRequest(response: DebugProtocol.DisconnectResponse, args: DebugProtocol.DisconnectArguments): void {
		
		log.debug('Received disconnectRequest');
		
		let detachPromises: Promise<void>[] = [];
		this.threadsById.forEach((threadAdapter) => {
			detachPromises.push(threadAdapter.actor.detach());
		});

		Promise.all(detachPromises).then(
			() => {
				log.debug('All threads detached');
				this.disconnect();
				this.sendResponse(response);
			},
			(err) => {
				log.warn(`Error while detaching: ${err}`);
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
