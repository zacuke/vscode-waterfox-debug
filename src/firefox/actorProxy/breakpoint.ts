import { EventEmitter } from 'events';
import { DebugConnection } from '../connection';
import { PendingRequests } from './pendingRequests';
import { ActorProxy } from './interface';

export class BreakpointActorProxy extends EventEmitter implements ActorProxy {

	private pendingDeleteRequests = new PendingRequests<void>();

	constructor(private _name: string, private connection: DebugConnection) {
		super();
		this.connection.register(this);
	}

	public get name() {
		return this._name;
	}

	public delete(): Promise<void> {
		return new Promise<void>((resolve, reject) => {
			this.pendingDeleteRequests.enqueue({ resolve, reject });
			this.connection.sendRequest({ to: this.name, type: 'delete' });
		});
	}

	public receiveResponse(response: FirefoxDebugProtocol.Response): void {
		
		this.pendingDeleteRequests.resolveAll(null);
		
	}
}
