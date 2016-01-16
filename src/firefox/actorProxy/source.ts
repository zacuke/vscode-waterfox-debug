import { EventEmitter } from 'events';
import { DebugConnection } from '../connection';
import { PendingRequests } from './pendingRequests';
import { ActorProxy } from './interface';
import { BreakpointActorProxy } from './breakpoint';

export class SourceActorProxy extends EventEmitter implements ActorProxy {

	private pendingSetBreakpointRequests = new PendingRequests<SetBreakpointResult>();

	constructor(private _source: FirefoxDebugProtocol.Source, private connection: DebugConnection) {
		super();
		this.connection.register(this);
	}

	public get name() {
		return this._source.actor;
	}

	public get url() {
		return this._source.url;
	}

	public setBreakpoint(location: FirefoxDebugProtocol.SourceLocation): Promise<SetBreakpointResult> {
		return new Promise<SetBreakpointResult>((resolve, reject) => {
			this.pendingSetBreakpointRequests.enqueue({ resolve, reject });
			this.connection.sendRequest({ to: this.name, type: 'setBreakpoint', location: location });
		});
	}

	public receiveResponse(response: FirefoxDebugProtocol.Response): void {
		
		if (response['isPending'] !== undefined) {
			
			//TODO actualLocation may be omitted!?
			//TODO create breakpointActor so that the breakpoint can be deleted
			let setBreakpointResponse = <FirefoxDebugProtocol.SetBreakpointResponse>response;
			let actualLocation = setBreakpointResponse.actualLocation;
			let breakpointActor = this.connection.getOrCreate(setBreakpointResponse.actor,
				() => new BreakpointActorProxy(setBreakpointResponse.actor, this.connection));
			this.pendingSetBreakpointRequests.resolveOne(new SetBreakpointResult(breakpointActor, actualLocation));
			
		} else {
			
			console.log("Unknown message from SourceActor: ", JSON.stringify(response));
		
		}
	}
}

export class SetBreakpointResult {
	constructor(
		public breakpointActor: BreakpointActorProxy,
		public actualLocation: FirefoxDebugProtocol.SourceLocation
	) {}
}
