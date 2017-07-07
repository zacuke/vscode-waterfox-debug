import { Log } from '../../util/log';
import { DebugConnection } from '../connection';
import { PendingRequests } from '../../util/pendingRequests';
import { ActorProxy } from './interface';

let log = Log.create('BreakpointActorProxy');

export class BreakpointActorProxy implements ActorProxy {

	private pendingDeleteRequests = new PendingRequests<void>();

	constructor(
		public readonly name: string,
		private connection: DebugConnection
	) {
		this.connection.register(this);
	}

	public delete(): Promise<void> {
		
		log.debug(`Deleting breakpoint ${this.name}`);
		
		return new Promise<void>((resolve, reject) => {
			this.pendingDeleteRequests.enqueue({ resolve, reject });
			this.connection.sendRequest({ to: this.name, type: 'delete' });
		});
	}

	public receiveResponse(response: FirefoxDebugProtocol.Response): void {
		
		log.debug(`Breakpoint ${this.name} deleted`);
		
		this.pendingDeleteRequests.resolveAll(undefined);
		this.connection.unregister(this);
	}
}
