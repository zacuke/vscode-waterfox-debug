import { DebugSession, InitializedEvent, TerminatedEvent, StoppedEvent, OutputEvent, ThreadEvent, Thread, StackFrame, Scope, Source } from 'vscode-debugadapter';
import { DebugProtocol } from 'vscode-debugprotocol';
import { ActorProxy, TabActorProxy, ThreadActorProxy, SourceActorProxy, BreakpointActorProxy } from './mozilla/actorProxy';
import { MozDebugConnection } from './mozilla/mozDebugConnection';

class FirefoxDebugSession extends DebugSession {

	private mozDebugConnection: MozDebugConnection;

	private nextThreadId = 1;
	private threadsById = new Map<number, ThreadInfo>();
	private threadsByActorName = new Map<string, ThreadInfo>();
	private breakpointsBySourceUrl = new Map<string, DebugProtocol.SetBreakpointsArguments>();
	
	public constructor(debuggerLinesStartAt1: boolean, isServer: boolean = false) {
		super(debuggerLinesStartAt1, isServer);
	}

	protected initializeRequest(response: DebugProtocol.InitializeResponse, args: DebugProtocol.InitializeRequestArguments): void {
		this.sendResponse(response);

		// connect to Firefox
		this.mozDebugConnection = new MozDebugConnection();

		// attach to all tabs, register the corresponding threads
		// and inform VSCode about them
		this.mozDebugConnection.rootActor.onTabOpened((tabActor) => {
			tabActor.attach().then((threadActor) => {

				let threadId = this.nextThreadId++;
				let threadInfo = new ThreadInfo(threadId, threadActor);
				this.threadsById.set(threadId, threadInfo);
				this.threadsByActorName.set(threadActor.name, threadInfo);

				threadActor.onNewSource((sourceActor) => {
					let sourceInfo = new SourceInfo(sourceActor);
					threadInfo.sources.push(sourceInfo);
					if (this.breakpointsBySourceUrl.has(sourceActor.url)) {
						let breakpoints = this.breakpointsBySourceUrl.get(sourceActor.url).lines;
						this.setBreakpointsOnSourceActor(breakpoints, sourceInfo, threadActor);
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

		this.mozDebugConnection.rootActor.fetchTabs();
		
		// now we are ready to accept breakpoints -> fire the initialized event to give UI a chance to set breakpoints
		this.sendEvent(new InitializedEvent());
	}

	protected threadsRequest(response: DebugProtocol.ThreadsResponse): void {

		let responseThreads: Thread[] = [];
		this.threadsById.forEach((threadInfo) => {
			responseThreads.push(new Thread(threadInfo.id, threadInfo.actor.name));
		});
		response.body = { threads: responseThreads };
		
		this.sendResponse(response);
	}
	
    protected setBreakPointsRequest(response: DebugProtocol.SetBreakpointsResponse, args: DebugProtocol.SetBreakpointsArguments): void {

		let firefoxSourceUrl = this.convertDebuggerPathToClient(args.source.path);
		this.breakpointsBySourceUrl.set(firefoxSourceUrl, args);

		let responseScheduled = false;		
		this.threadsById.forEach((threadInfo) => {
			
			let sourceInfo: SourceInfo = null;
			for (let i = 0; i < threadInfo.sources.length; i++) {
				if (threadInfo.sources[i].actor.url === firefoxSourceUrl) {
					sourceInfo = threadInfo.sources[i];
					break;
				}
			}

			if (sourceInfo !== null) {
				let setBreakpointsPromise = this.setBreakpointsOnSourceActor(args.lines, sourceInfo, threadInfo.actor);
				if (!responseScheduled) {
					setBreakpointsPromise.then((breakpointInfos) => {

						response.body.breakpoints = breakpointInfos.map((breakpointInfo) => 
							<DebugProtocol.Breakpoint>{ verified: true, line: breakpointInfo.actualLine });

						this.sendResponse(response);
						
					});
					responseScheduled = true;
				}
			}
		});
	}
	
	private setBreakpointsOnSourceActor(breakpointsToSet: number[], sourceInfo: SourceInfo, threadActor: ThreadActorProxy): Promise<BreakpointInfo[]> {
		return threadActor.runOnPausedThread((resume) => 
			this.setBreakpointsOnPausedSourceActor(breakpointsToSet, sourceInfo, resume));
	}

	private setBreakpointsOnPausedSourceActor(breakpointsToSet: number[], sourceInfo: SourceInfo, resume: () => void): Promise<BreakpointInfo[]> {
		
		let result = new Promise<BreakpointInfo[]>((resolve) => {
			sourceInfo.currentBreakpoints.then((oldBreakpoints) => {
				
				let newBreakpoints: BreakpointInfo[] = [];
				let breakpointsBeingRemoved: Promise<void>[] = [];
				let breakpointsBeingSet: Promise<void>[] = [];
				
				oldBreakpoints.forEach((breakpointInfo) => {
					let breakpointIndex = breakpointsToSet.indexOf(breakpointInfo.requestedLine);
					if (breakpointIndex >= 0) {
						newBreakpoints[breakpointIndex] = breakpointInfo;
						breakpointsToSet[breakpointIndex] = undefined;
					} else {
						breakpointsBeingRemoved.push(breakpointInfo.actor.delete());
					}
				});

				breakpointsToSet.map((requestedLine, index) => {
					if (requestedLine !== undefined) {
						breakpointsBeingSet.push(sourceInfo.actor.setBreakpoint({ line: requestedLine })
						.then((setBreakpointResult) => {
							newBreakpoints[index] = new BreakpointInfo(
								requestedLine, setBreakpointResult.actualLocation.line, setBreakpointResult.breakpointActor); 
						}));
					}
				});
				
				Promise.all(breakpointsBeingRemoved).then(() => Promise.all(breakpointsBeingSet)).then(() => {
					resolve(newBreakpoints);
					resume();
				});
			});
		});
		
		sourceInfo.currentBreakpoints = result;
		return result;
	}

	protected pauseRequest(response: DebugProtocol.PauseResponse, args: DebugProtocol.PauseArguments): void {
		this.threadsById.get(args.threadId).actor.interrupt();
		this.sendResponse(response);
	}
	
	protected continueRequest(response: DebugProtocol.ContinueResponse, args: DebugProtocol.ContinueArguments): void {
		this.threadsById.get(args.threadId).actor.resume();
		this.sendResponse(response);
	}

	protected nextRequest(response: DebugProtocol.NextResponse, args: DebugProtocol.NextArguments): void {
		this.threadsById.get(args.threadId).actor.stepOver();
		this.sendResponse(response);
	}

	protected stepInRequest(response: DebugProtocol.StepInResponse, args: DebugProtocol.StepInArguments): void {
		this.threadsById.get(args.threadId).actor.stepInto();
		this.sendResponse(response);
	}

	protected stepOutRequest(response: DebugProtocol.StepOutResponse, args: DebugProtocol.StepOutArguments): void {
		this.threadsById.get(args.threadId).actor.stepOut();
		this.sendResponse(response);
	}
}

class ThreadInfo {
	public id: number;
	public actor: ThreadActorProxy;
	public sources: SourceInfo[];
	
	public constructor(id: number, actor: ThreadActorProxy) {
		this.id = id;
		this.actor = actor;
		this.sources = [];
	}
}

class SourceInfo {
	public actor: SourceActorProxy;
	public currentBreakpoints: Promise<BreakpointInfo[]>;
	
	public constructor(actor: SourceActorProxy) {
		this.actor = actor;
		this.currentBreakpoints = Promise.resolve([]);
	}
}

class BreakpointInfo {
	public requestedLine: number;
	public actualLine: number;
	public actor: BreakpointActorProxy;
	
	public constructor(requestedLine: number, actualLine: number, actor: BreakpointActorProxy) {
		this.requestedLine = requestedLine;
		this.actualLine = actualLine;
		this.actor = actor;
	}
}

DebugSession.run(FirefoxDebugSession);
