import { Log } from './util/log';
import { DebugSession, InitializedEvent, TerminatedEvent, StoppedEvent, OutputEvent, ThreadEvent, Thread, StackFrame, Scope, Variable, Source } from 'vscode-debugadapter';
import { DebugProtocol } from 'vscode-debugprotocol';
import { DebugConnection, ActorProxy, TabActorProxy, ThreadActorProxy, SourceActorProxy, BreakpointActorProxy, ObjectGripActorProxy, LongStringGripActorProxy } from './firefox/index';
import { ThreadAdapter, SourceAdapter, BreakpointAdapter, FrameAdapter, EnvironmentAdapter, VariablesProvider } from './adapter/index';
import { VariableAdapter } from './adapter/index';

let log = Log.create('FirefoxDebugSession');

export class FirefoxDebugSession extends DebugSession {

	private firefoxDebugConnection: DebugConnection;

	private nextThreadId = 1;
	private threadsById = new Map<number, ThreadAdapter>();
	private breakpointsBySourceUrl = new Map<string, DebugProtocol.SetBreakpointsArguments>();

	private nextFrameId = 1;
	private framesById = new Map<number, FrameAdapter>();

	private nextVariablesProviderId = 1;
	private variablesProvidersById = new Map<number, VariablesProvider>();

	private nextSourceId = 1;
	private sourcesById = new Map<number, SourceAdapter>();
	
	public constructor(debuggerLinesStartAt1: boolean, isServer: boolean = false) {
		super(debuggerLinesStartAt1, isServer);
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
		return this.firefoxDebugConnection.getOrCreate(objectGrip.actor, 
			() => {
				let actorProxy = new ObjectGripActorProxy(objectGrip, this.firefoxDebugConnection);
				actorProxy.extendLifetime();
				return actorProxy;
			});
	}
	
	public getOrCreateLongStringGripActorProxy(longStringGrip: FirefoxDebugProtocol.LongStringGrip): LongStringGripActorProxy {
		return this.firefoxDebugConnection.getOrCreate(longStringGrip.actor, () => 
			new LongStringGripActorProxy(longStringGrip, this.firefoxDebugConnection));
	}
	
	protected initializeRequest(response: DebugProtocol.InitializeResponse, args: DebugProtocol.InitializeRequestArguments): void {
		
		response.body = {
			supportsConfigurationDoneRequest: false,
			supportsEvaluateForHovers: false,
			supportsFunctionBreakpoints: false
		};
		this.sendResponse(response);

		// connect to Firefox
		this.firefoxDebugConnection = new DebugConnection();

		// attach to all tabs, register the corresponding threads
		// and inform VSCode about them
		this.firefoxDebugConnection.rootActor.onTabOpened((tabActor) => {
			
			log.info(`Tab opened with url ${tabActor.url}`);
			
			tabActor.attach().then(
			(threadActor) => {

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
						let breakpoints = this.breakpointsBySourceUrl.get(sourceActor.url).breakpoints;
						this.setBreakpointsOnSourceActor(breakpoints, sourceAdapter, threadActor);
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
				

				threadActor.resume();

				this.sendEvent(new ThreadEvent('started', threadId));
			},
			(err) => {
				log.error(`Failed attaching to tab/thread: ${err}`);
			});
		});

		this.firefoxDebugConnection.rootActor.fetchTabs();
		
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

		log.debug(`Received setBreakpointsRequest with ${args.lines.length} breakpoints for ${args.source.path}`);

		let firefoxSourceUrl = 'file://' + this.convertDebuggerPathToClient(args.source.path);
		this.breakpointsBySourceUrl.set(firefoxSourceUrl, args);

		let responseScheduled = false;		
		this.threadsById.forEach((threadAdapter) => {
			
			let sourceAdapter = threadAdapter.findSourceAdapterForUrl(firefoxSourceUrl);
			if (sourceAdapter !== null) {

				log.debug(`Found source ${args.source.path} on tab ${threadAdapter.actor.name}`);
				
				let setBreakpointsPromise = this.setBreakpointsOnSourceActor(args.breakpoints, sourceAdapter, threadAdapter.actor);
				
				if (!responseScheduled) {

					setBreakpointsPromise.then(
						(breakpointAdapters) => {

							response.body = { breakpoints: breakpointAdapters.map((breakpointAdapter) => 
								<DebugProtocol.Breakpoint>{ verified: true, line: breakpointAdapter.actualLine }) };

							log.debug('Replying to setBreakpointsRequest with actual breakpoints from the first thread with this source');

							this.sendResponse(response);
							
						},
						(err) => {
							log.error(`Failed setting breakpoints: ${err}`);
							response.success = false;
							response.message = String(err);
							this.sendResponse(response);
						});
						
					responseScheduled = true;
				}
			}
		});
		
		if (!responseScheduled) {
			log.warn(`Unknown source ${args.source.path}`);
			response.body = { 
				breakpoints: args.breakpoints.map(
					(breakpoint) => <DebugProtocol.Breakpoint>{ verified: false, line: breakpoint.line })
			};
			this.sendResponse(response);
		}
	}
	
	private setBreakpointsOnSourceActor(breakpointsToSet: DebugProtocol.SourceBreakpoint[], sourceAdapter: SourceAdapter, threadActor: ThreadActorProxy): Promise<BreakpointAdapter[]> {
		return threadActor.runOnPausedThread((resume) => 
			this.setBreakpointsOnPausedSourceActor(breakpointsToSet, sourceAdapter, resume));
	}

	private setBreakpointsOnPausedSourceActor(breakpointsToSet: DebugProtocol.SourceBreakpoint[], sourceAdapter: SourceAdapter, resume: () => void): Promise<BreakpointAdapter[]> {

		log.debug(`Setting ${breakpointsToSet.length} breakpoints for ${sourceAdapter.actor.url}`);
		
		let result = new Promise<BreakpointAdapter[]>((resolve, reject) => {

			sourceAdapter.currentBreakpoints.then(
				
				(oldBreakpoints) => {

					log.debug(`${oldBreakpoints.length} breakpoints were previously set for ${sourceAdapter.actor.url}`);

					let newBreakpoints: BreakpointAdapter[] = [];
					let breakpointsBeingRemoved: Promise<void>[] = [];
					let breakpointsBeingSet: Promise<void>[] = [];
					
					oldBreakpoints.forEach((breakpointAdapter) => {
						
						let breakpointIndex = -1;
						for (let i = 0; i < breakpointsToSet.length; i++) {
							if ((breakpointsToSet[i] !== undefined) && 
								(breakpointsToSet[i].line === breakpointAdapter.requestedBreakpoint.line)) {
								breakpointIndex = i;
								break;
							}
						}
						
						if (breakpointIndex >= 0) {
							newBreakpoints[breakpointIndex] = breakpointAdapter;
							breakpointsToSet[breakpointIndex] = undefined;
						} else {
							breakpointsBeingRemoved.push(breakpointAdapter.actor.delete());
						}
					});

					breakpointsToSet.map((requestedBreakpoint, index) => {
						if (requestedBreakpoint !== undefined) {

							breakpointsBeingSet.push(
								sourceAdapter.actor
								.setBreakpoint({ line: requestedBreakpoint.line }, requestedBreakpoint.condition)
								.then((setBreakpointResult) => {

									let actualLine = (setBreakpointResult.actualLocation === undefined) ? 
										requestedBreakpoint.line : 
										setBreakpointResult.actualLocation.line;

									newBreakpoints[index] = new BreakpointAdapter(requestedBreakpoint, actualLine, setBreakpointResult.breakpointActor); 
								}));
						}
					});
					
					log.debug(`Adding ${breakpointsBeingSet.length} and removing ${breakpointsBeingRemoved.length} breakpoints`);

					Promise.all(breakpointsBeingRemoved).then(() => 
					Promise.all(breakpointsBeingSet)).then(
						() => {
							resolve(newBreakpoints);
							resume();
						},
						(err) => {
							log.error(`Failed setting breakpoints: ${err}`);
							reject(err);
							resume();
						});
				});
		});
		
		sourceAdapter.currentBreakpoints = result;
		return result;
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

		threadAdapter.fetchStackFrames(args.levels).then(
			(frameAdapters) => {

				response.body = { stackFrames: frameAdapters.map((frameAdapter) => frameAdapter.getStackframe()) };
				this.sendResponse(response);

			},
			(err) => {
				log.error(`Failed fetching stackframes: ${err}`);
				response.success = false;
				response.message = String(err);
				this.sendResponse(response);
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
		
		let environmentAdapter = EnvironmentAdapter.from(frameAdapter.frame.environment);
		let scopeAdapters = environmentAdapter.getScopeAdapters(frameAdapter.threadAdapter, frameAdapter.frame.this);
		scopeAdapters[0].addThis(frameAdapter.frame.this);
		
		response.body = { scopes: scopeAdapters.map((scopeAdapter) => scopeAdapter.getScope()) };
		
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
		
		variablesProvider.getVariables().then(
			(vars) => {
				response.body = { variables: vars };
				this.sendResponse(response);
			},
			(err) => {
				response.success = false;
				response.message = String(err);
				this.sendResponse(response);
			});
	}
	
	protected evaluateRequest(response: DebugProtocol.EvaluateResponse, args: DebugProtocol.EvaluateArguments): void {
		
		log.debug('Received evaluateRequest');
		
		if (args.frameId !== undefined) {
			
			let frameAdapter = this.framesById.get(args.frameId);
			
			frameAdapter.evaluate(args.expression)
			.then(
				(grip) => {

					let variable = (grip === undefined) ? new Variable('', 'undefined') : VariableAdapter.getVariableFromGrip('', grip, (args.context !== 'watch'), frameAdapter.threadAdapter);
					response.body = { result: variable.value, variablesReference: variable.variablesReference };
					this.sendResponse(response);

				},
				(err) => {
					log.error(`Failed evaluating "${args.expression}": ${err}`);
					response.success = false;
					response.message = String(err);
					this.sendResponse(response);
				});
			
		} else {
			log.error(`Failed evaluating "${args.expression}": Can't find requested evaluation frame`);
			response.success = false;
			response.message = String('Can\'t find requested evaluation frame');
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
				this.sendResponse(response);
			},
			(err) => {
				log.warn(`Error while detaching: ${err}`);
				this.sendResponse(response);
			});
	}

}

DebugSession.run(FirefoxDebugSession);
