import { Log } from './util/log';
import { DebugSession, InitializedEvent, TerminatedEvent, StoppedEvent, OutputEvent, ThreadEvent, BreakpointEvent, Thread, StackFrame, Scope, Variable, Source, Breakpoint } from 'vscode-debugadapter';
import { DebugProtocol } from 'vscode-debugprotocol';
import { DebugConnection, ActorProxy, TabActorProxy, ThreadActorProxy, SourceActorProxy, BreakpointActorProxy, ObjectGripActorProxy, LongStringGripActorProxy } from './firefox/index';
import { ThreadAdapter, BreakpointInfo, BreakpointsAdapter, SourceAdapter, BreakpointAdapter, FrameAdapter, EnvironmentAdapter, VariablesProvider } from './adapter/index';
import { VariableAdapter } from './adapter/index';

let log = Log.create('FirefoxDebugSession');

export class FirefoxDebugSession extends DebugSession {

	private firefoxDebugConnection: DebugConnection;

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
						
						let breakpointInfos = this.breakpointsBySourceUrl.get(sourceActor.url);
						let setBreakpointsPromise = BreakpointsAdapter.setBreakpointsOnSourceActor(
							breakpointInfos, sourceAdapter, threadActor);
						
						if (this.verifiedBreakpointSources.indexOf(sourceActor.url) < 0) {
						
							setBreakpointsPromise.then((breakpointAdapters) => {

								log.debug('Updating breakpoints');

								breakpointAdapters.forEach((breakpointAdapter) => {
									let breakpoint: DebugProtocol.Breakpoint = new Breakpoint(true, breakpointAdapter.breakpointInfo.actualLine);
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

		log.debug(`Received setBreakpointsRequest with ${args.breakpoints.length} breakpoints for ${args.source.path}`);

		let firefoxSourceUrl = 'file://' + this.convertDebuggerPathToClient(args.source.path);
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
									(breakpointAdapter) => <DebugProtocol.Breakpoint>{
										id: breakpointAdapter.breakpointInfo.id,
										line: breakpointAdapter.breakpointInfo.actualLine,
										verified: true
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
				breakpoints: breakpointInfos.map((breakpointInfo) => <DebugProtocol.Breakpoint>{
					id: breakpointInfo.id,
					line: breakpointInfo.requestedLine,
					verified: false
				})
			};

			this.sendResponse(response);
		}
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
