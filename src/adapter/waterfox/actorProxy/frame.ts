import { Log } from '../../util/log';
import { DebugConnection } from '../connection';
import { PendingRequest } from '../../util/pendingRequests';
import { ActorProxy } from './interface';

let log = Log.create('FrameActorProxy');

/**
 * Proxy class for a frame actor
 * ([docs](https://github.com/mozilla/gecko-dev/blob/master/devtools/docs/backend/protocol.md#listing-stack-frames),
 * [spec](https://github.com/mozilla/gecko-dev/blob/master/devtools/shared/specs/frame.js))
 */
export class FrameActorProxy implements ActorProxy {

	private pendingGetEnvironmentRequest?: PendingRequest<WaterfoxDebugProtocol.Environment>;
	private getEnvironmentPromise?: Promise<WaterfoxDebugProtocol.Environment>;

	constructor(
		private frame: WaterfoxDebugProtocol.Frame,
		private connection: DebugConnection
	) {
		this.connection.register(this);
	}

	public get name() {
		return this.frame.actor;
	}

	public getEnvironment(): Promise<WaterfoxDebugProtocol.Environment> {

		if (!this.getEnvironmentPromise) {

			log.debug(`Fetching environment from ${this.name}`);

			this.getEnvironmentPromise = new Promise<WaterfoxDebugProtocol.Environment>((resolve, reject) => {
				this.pendingGetEnvironmentRequest = { resolve, reject };
				this.connection.sendRequest({ to: this.name, type: 'getEnvironment' });
			});
		}

		return this.getEnvironmentPromise;
	}

	public receiveResponse(response: WaterfoxDebugProtocol.Response): void {

		if (this.pendingGetEnvironmentRequest) {

			log.debug(`Environment fetched from ${this.name}`);
			this.pendingGetEnvironmentRequest.resolve(response as (WaterfoxDebugProtocol.Environment & WaterfoxDebugProtocol.Response));

		} else {

			log.warn("Unknown/unexpected message from FrameActor: " + JSON.stringify(response));

		}
	}

	public dispose(): void {
		this.connection.unregister(this);
	}
}
