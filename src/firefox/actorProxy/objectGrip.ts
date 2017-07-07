import { Log } from '../../util/log';
import { DebugConnection } from '../connection';
import { PendingRequests, PendingRequest } from '../../util/pendingRequests';
import { ActorProxy } from './interface';

let log = Log.create('ObjectGripActorProxy');

export class ObjectGripActorProxy implements ActorProxy {

	private _refCount = 0;

	private pendingThreadGripRequest: PendingRequest<void> | undefined = undefined;
	private threadGripPromise: Promise<void> | undefined = undefined;
 	private pendingPrototypeAndPropertiesRequests = new PendingRequests<FirefoxDebugProtocol.PrototypeAndPropertiesResponse>();

	constructor(
		private grip: FirefoxDebugProtocol.ObjectGrip,
		private connection: DebugConnection
	) {
		this.connection.register(this);
	}

	public get name() {
		return this.grip.actor;
	}

	public get refCount() {
		return this._refCount;
	}

	public increaseRefCount() {
		this._refCount++;
	}

	public decreaseRefCount() {
		this._refCount--;
		if (this._refCount === 0) {
			this.connection.unregister(this);
		}
	}

	public extendLifetime(): Promise<void> {
		if (this.threadGripPromise) {
			return this.threadGripPromise;
		}

		if (log.isDebugEnabled()) {
			log.debug(`Extending lifetime of ${this.name}`);
		}

		this.threadGripPromise = new Promise<void>((resolve, reject) => {
			this.pendingThreadGripRequest = { resolve, reject };
			this.connection.sendRequest({ to: this.name, type: 'threadGrip' });
		});
		return this.threadGripPromise;
	}

	public fetchPrototypeAndProperties(): Promise<FirefoxDebugProtocol.PrototypeAndPropertiesResponse> {

		if (log.isDebugEnabled()) {
			log.debug(`Fetching prototype and properties from ${this.name}`);
		}

		return new Promise<FirefoxDebugProtocol.PrototypeAndPropertiesResponse>((resolve, reject) => {
			this.pendingPrototypeAndPropertiesRequests.enqueue({ resolve, reject });
			this.connection.sendRequest({ to: this.name, type: 'prototypeAndProperties' });
		});
	}

	public receiveResponse(response: FirefoxDebugProtocol.Response): void {

		if ((response['prototype'] !== undefined) && (response['ownProperties'] !== undefined)) {

			if (log.isDebugEnabled()) {
				log.debug(`Prototype and properties fetched from ${this.name}`);
			}
			this.pendingPrototypeAndPropertiesRequests.resolveOne(<FirefoxDebugProtocol.PrototypeAndPropertiesResponse>response);

		} else if (Object.keys(response).length === 1) {

			log.debug('Received response to threadGrip request');

			if (this.pendingThreadGripRequest) {
				this.pendingThreadGripRequest.resolve(undefined);
				this.pendingThreadGripRequest = undefined;
			} else {
				log.warn('Received threadGrip response without pending request');
			}

		} else if (response['error'] === 'noSuchActor') {

			log.warn(`No such actor ${this.grip.actor} - you will not be able to inspect this value; this is probably due to Firefox bug #1249962`);
			this.pendingPrototypeAndPropertiesRequests.rejectAll('No such actor');
			if (this.pendingThreadGripRequest) {
				this.pendingThreadGripRequest.resolve(undefined);
				this.pendingThreadGripRequest = undefined;
			}

		} else {

			log.warn("Unknown message from ObjectGripActor: " + JSON.stringify(response));

		}
	}
}
