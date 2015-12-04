import { DebugSession, InitializedEvent, TerminatedEvent, StoppedEvent, OutputEvent, ThreadEvent, Thread, StackFrame, Scope, Source} from './vscode/debugSession';
import { TabActorProxy } from './mozilla/actorProxy';
import { MozDebugConnection } from './mozilla/mozDebugConnection';

class FirefoxDebugSession extends DebugSession {

	private mozDebugConnection: MozDebugConnection;
	private nextThreadId = 1;
	
	// map threadIds to tabActors
	private tabs = new Map<number, TabActorProxy>();
	// map tabActor names to threadIds
	private tabThreadIds = new Map<string, number>();
	
	public constructor(debuggerLinesStartAt1: boolean, isServer: boolean = false) {
		super(debuggerLinesStartAt1, isServer);
	}

	protected initializeRequest(response: DebugProtocol.InitializeResponse, args: DebugProtocol.InitializeRequestArguments): void {
		this.sendResponse(response);

		// connect to Firefox
		this.mozDebugConnection = new MozDebugConnection();

		this.mozDebugConnection.rootActor.onTabOpened((tabActor) => {
			let threadId = this.nextThreadId++;
			this.tabs.set(threadId, tabActor);
			this.tabThreadIds.set(tabActor.name, threadId);
			this.sendEvent(new ThreadEvent('started', threadId));
		});

		this.mozDebugConnection.rootActor.onTabClosed((tabActor) => {
			let threadId = this.tabThreadIds.get(tabActor.name);
			this.tabs.delete(threadId);
			this.tabThreadIds.delete(tabActor.name);
			this.sendEvent(new ThreadEvent('exited', threadId));
		})
		
		this.mozDebugConnection.rootActor.fetchTabs();
		
		// now we are ready to accept breakpoints -> fire the initialized event to give UI a chance to set breakpoints
		this.sendEvent(new InitializedEvent());
	}

	protected threadsRequest(response: DebugProtocol.ThreadsResponse): void {
		// initially, we return no threads - all threads will be registered later
		response.body = { threads: [] };
		this.sendResponse(response);
	}
}

DebugSession.run(FirefoxDebugSession);
