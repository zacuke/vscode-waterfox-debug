import { DebugSession, InitializedEvent, TerminatedEvent, StoppedEvent, OutputEvent, ThreadEvent, Thread, StackFrame, Scope, Variable, Source } from 'vscode-debugadapter';
import { DebugProtocol } from 'vscode-debugprotocol';
import { DebugConnection, ActorProxy, TabActorProxy, ThreadActorProxy, SourceActorProxy, BreakpointActorProxy, ObjectGripActorProxy } from './firefox/index';
import { ThreadAdapter, SourceAdapter, BreakpointAdapter, FrameAdapter, EnvironmentAdapter, VariablesProvider } from './adapter/index';

export class FirefoxDebugSession extends DebugSession {

	private firefoxDebugConnection: DebugConnection;

	private nextThreadId = 1;
	private threadsById = new Map<number, ThreadAdapter>();
	private threadsByActorName = new Map<string, ThreadAdapter>();
	private breakpointsBySourceUrl = new Map<string, DebugProtocol.SetBreakpointsArguments>();

	private nextFrameId = 1;
	private framesById = new Map<number, FrameAdapter>();

	private nextVariablesProviderId = 1;
	private variablesProvidersById = new Map<number, VariablesProvider>();

	public constructor(debuggerLinesStartAt1: boolean, isServer: boolean = false) {
		super(debuggerLinesStartAt1, isServer);
	}

	public registerVariablesProvider(variablesProvider: VariablesProvider) {
		let providerId = this.nextVariablesProviderId++;
		variablesProvider.variablesProviderId = providerId;
		this.variablesProvidersById.set(providerId, variablesProvider);
	}

	public createObjectGripActorProxy(objectGrip: FirefoxDebugProtocol.ObjectGrip): ObjectGripActorProxy {
		return new ObjectGripActorProxy(objectGrip, this.firefoxDebugConnection);
	}
	
	protected initializeRequest(response: DebugProtocol.InitializeResponse, args: DebugProtocol.InitializeRequestArguments): void {
		this.sendResponse(response);

		// connect to Firefox
		this.firefoxDebugConnection = new DebugConnection();

		// attach to all tabs, register the corresponding threads
		// and inform VSCode about them
		this.firefoxDebugConnection.rootActor.onTabOpened((tabActor) => {
			tabActor.attach().then((threadActor) => {

				let threadId = this.nextThreadId++;
				let threadAdapter = new ThreadAdapter(threadId, threadActor);
				this.threadsById.set(threadId, threadAdapter);
				this.threadsByActorName.set(threadActor.name, threadAdapter);

				threadActor.onNewSource((sourceActor) => {
					let sourceAdapter = new SourceAdapter(sourceActor);
					threadAdapter.sources.push(sourceAdapter);
					if (this.breakpointsBySourceUrl.has(sourceActor.url)) {
						let breakpoints = this.breakpointsBySourceUrl.get(sourceActor.url).lines;
						this.setBreakpointsOnSourceActor(breakpoints, sourceAdapter, threadActor);
					}
				});
				
				threadActor.onPaused((why) => {
					this.sendEvent(new StoppedEvent(why, threadId));
				});
				
				threadActor.onExited(() => {
					this.threadsById.delete(threadId);
					this.threadsByActorName.delete(threadActor.name);
					this.sendEvent(new ThreadEvent('exited', threadId));
				});
				
				threadActor.fetchSources();

				this.sendEvent(new ThreadEvent('started', threadId));
			});
		});

		this.firefoxDebugConnection.rootActor.fetchTabs();
		
		// now we are ready to accept breakpoints -> fire the initialized event to give UI a chance to set breakpoints
		this.sendEvent(new InitializedEvent());
	}

	protected threadsRequest(response: DebugProtocol.ThreadsResponse): void {

		let responseThreads: Thread[] = [];
		this.threadsById.forEach((threadAdapter) => {
			responseThreads.push(new Thread(threadAdapter.id, threadAdapter.actor.name));
		});
		response.body = { threads: responseThreads };
		
		this.sendResponse(response);
	}
	
    protected setBreakPointsRequest(response: DebugProtocol.SetBreakpointsResponse, args: DebugProtocol.SetBreakpointsArguments): void {

		let firefoxSourceUrl = 'file://' + this.convertDebuggerPathToClient(args.source.path);
		this.breakpointsBySourceUrl.set(firefoxSourceUrl, args);

		let responseScheduled = false;		
		this.threadsById.forEach((threadAdapter) => {
			
			let sourceAdapter: SourceAdapter = null;
			for (let i = 0; i < threadAdapter.sources.length; i++) {
				if (threadAdapter.sources[i].actor.url === firefoxSourceUrl) {
					sourceAdapter = threadAdapter.sources[i];
					break;
				}
			}

			if (sourceAdapter !== null) {
				let setBreakpointsPromise = this.setBreakpointsOnSourceActor(args.lines, sourceAdapter, threadAdapter.actor);
				if (!responseScheduled) {
					setBreakpointsPromise.then((breakpointAdapters) => {

						response.body = { breakpoints: breakpointAdapters.map((breakpointAdapter) => 
							<DebugProtocol.Breakpoint>{ verified: true, line: breakpointAdapter.actualLine }) };

						this.sendResponse(response);
						
					});
					responseScheduled = true;
				}
			}
		});
	}
	
	private setBreakpointsOnSourceActor(breakpointsToSet: number[], sourceAdapter: SourceAdapter, threadActor: ThreadActorProxy): Promise<BreakpointAdapter[]> {
		return threadActor.runOnPausedThread((resume) => 
			this.setBreakpointsOnPausedSourceActor(breakpointsToSet, sourceAdapter, resume));
	}

	private setBreakpointsOnPausedSourceActor(breakpointsToSet: number[], sourceAdapter: SourceAdapter, resume: () => void): Promise<BreakpointAdapter[]> {
		
		let result = new Promise<BreakpointAdapter[]>((resolve) => {
			sourceAdapter.currentBreakpoints.then((oldBreakpoints) => {
				
				let newBreakpoints: BreakpointAdapter[] = [];
				let breakpointsBeingRemoved: Promise<void>[] = [];
				let breakpointsBeingSet: Promise<void>[] = [];
				
				oldBreakpoints.forEach((breakpointAdapter) => {
					let breakpointIndex = breakpointsToSet.indexOf(breakpointAdapter.requestedLine);
					if (breakpointIndex >= 0) {
						newBreakpoints[breakpointIndex] = breakpointAdapter;
						breakpointsToSet[breakpointIndex] = undefined;
					} else {
						breakpointsBeingRemoved.push(breakpointAdapter.actor.delete());
					}
				});

				breakpointsToSet.map((requestedLine, index) => {
					if (requestedLine !== undefined) {
						breakpointsBeingSet.push(sourceAdapter.actor.setBreakpoint({ line: requestedLine })
						.then((setBreakpointResult) => {
							let actualLine = (setBreakpointResult.actualLocation === undefined) ? requestedLine : setBreakpointResult.actualLocation.line;
							newBreakpoints[index] = new BreakpointAdapter(requestedLine, actualLine, setBreakpointResult.breakpointActor); 
						}));
					}
				});
				
				Promise.all(breakpointsBeingRemoved).then(() => Promise.all(breakpointsBeingSet)).then(() => {
					resolve(newBreakpoints);
					resume();
				});
			});
		});
		
		sourceAdapter.currentBreakpoints = result;
		return result;
	}

	protected pauseRequest(response: DebugProtocol.PauseResponse, args: DebugProtocol.PauseArguments): void {
		this.threadsById.get(args.threadId).actor.interrupt();
		this.sendResponse(response);
	}
	
	protected continueRequest(response: DebugProtocol.ContinueResponse, args: DebugProtocol.ContinueArguments): void {
		this.terminatePause();
		this.threadsById.get(args.threadId).actor.resume();
		this.sendResponse(response);
	}

	protected nextRequest(response: DebugProtocol.NextResponse, args: DebugProtocol.NextArguments): void {
		this.terminatePause();
		this.threadsById.get(args.threadId).actor.stepOver();
		this.sendResponse(response);
	}

	protected stepInRequest(response: DebugProtocol.StepInResponse, args: DebugProtocol.StepInArguments): void {
		this.terminatePause();
		this.threadsById.get(args.threadId).actor.stepInto();
		this.sendResponse(response);
	}

	protected stepOutRequest(response: DebugProtocol.StepOutResponse, args: DebugProtocol.StepOutArguments): void {
		this.terminatePause();
		this.threadsById.get(args.threadId).actor.stepOut();
		this.sendResponse(response);
	}
	
	private terminatePause() {
		this.variablesProvidersById.clear();
		this.framesById.clear();
	}
	
	protected stackTraceRequest(response: DebugProtocol.StackTraceResponse, args: DebugProtocol.StackTraceArguments): void {

		let threadActor = this.threadsById.get(args.threadId).actor;

		threadActor.fetchStackFrames().then((frames) => {

			let frameAdapters = frames.map((frame) => {
				let frameId = this.nextFrameId++;
				let frameAdapter = new FrameAdapter(frameId, frame);
				this.framesById.set(frameId, frameAdapter);
				return frameAdapter;
			});

			response.body.stackFrames = frameAdapters.map((frameAdapter) => frameAdapter.getStackframe());
			this.sendResponse(response);
		});
	}
	
	protected scopesRequest(response: DebugProtocol.ScopesResponse, args: DebugProtocol.ScopesArguments): void {
		
		let frameAdapter = this.framesById.get(args.frameId);
		let environmentAdapter = EnvironmentAdapter.from(frameAdapter.frame.environment);
		let scopeAdapters = environmentAdapter.getScopes(this);
		
		response.body.scopes = scopeAdapters.map((scopeAdapter) => scopeAdapter.getScope());
		
		this.sendResponse(response);
	}
	
	protected variablesRequest(response: DebugProtocol.VariablesResponse, args: DebugProtocol.VariablesArguments): void {
		
		let variablesProvider = this.variablesProvidersById.get(args.variablesReference);
		
		variablesProvider.getVariables(this).then((vars) => {
			response.body.variables = vars;
			this.sendResponse(response);
		})
	}
}

DebugSession.run(FirefoxDebugSession);
