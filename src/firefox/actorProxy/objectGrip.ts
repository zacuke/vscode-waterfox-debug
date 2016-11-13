import { Log } from '../../util/log';
import { EventEmitter } from 'events';
import { DebugConnection } from '../connection';
import { PendingRequests, PendingRequest } from './pendingRequests';
import { ActorProxy } from './interface';

let log = Log.create('ObjectGripActorProxy');

export class ObjectGripActorProxy implements ActorProxy {

	private pendingThreadGripRequest: PendingRequest<void> = null;
	private threadGripPromise: Promise<void> = null;
 	private pendingPrototypeAndPropertiesRequests = new PendingRequests<FirefoxDebugProtocol.PrototypeAndPropertiesResponse>();

	constructor(private grip: FirefoxDebugProtocol.ObjectGrip, private connection: DebugConnection) {
		this.connection.register(this);
	}

	public get name() {
		return this.grip.actor;
	}

	public extendLifetime(): Promise<void> {
		if (this.threadGripPromise != null) {
			return this.threadGripPromise;
		}
		
 		log.debug(`Extending lifetime of ${this.name}`);
		
		this.threadGripPromise = new Promise<void>((resolve, reject) => {
			this.pendingThreadGripRequest = { resolve, reject };
			this.connection.sendRequest({ to: this.name, type: 'threadGrip' });
		});
		return this.threadGripPromise;
	}
	
	public fetchPrototypeAndProperties(): Promise<FirefoxDebugProtocol.PrototypeAndPropertiesResponse> {
		
		log.debug(`Fetching prototype and properties from ${this.name}`);

		return new Promise<FirefoxDebugProtocol.PrototypeAndPropertiesResponse>((resolve, reject) => {
			this.pendingPrototypeAndPropertiesRequests.enqueue({ resolve, reject });
			this.connection.sendRequest({ to: this.name, type: 'prototypeAndProperties' });
		});
	}
	
	public dispose(): void {
		this.connection.unregister(this);
	}
	
	public receiveResponse(response: FirefoxDebugProtocol.Response): void {

		if ((response['prototype'] !== undefined) && (response['ownProperties'] !== undefined)) {
		
			log.debug(`Prototype and properties fetched from ${this.name}`);
			this.pendingPrototypeAndPropertiesRequests.resolveOne(<FirefoxDebugProtocol.PrototypeAndPropertiesResponse>response);
			
		} else if (Object.keys(response).length === 1) {
			
			log.debug('Received response to threadGrip request');

			if (this.pendingThreadGripRequest != null) {
				this.pendingThreadGripRequest.resolve(undefined);
				this.pendingThreadGripRequest = null;
			} else {
				log.warn('Received threadGrip response without pending request');
			}
			
		} else if (response['error'] === 'noSuchActor') {
			
			log.warn(`No such actor ${this.grip.actor} - you will not be able to inspect this value; this is probably due to Firefox bug #1249962}`);
			this.pendingPrototypeAndPropertiesRequests.rejectAll('No such actor');
			if (this.pendingThreadGripRequest != null) {
				this.pendingThreadGripRequest.resolve(undefined);
				this.pendingThreadGripRequest = null;
			}

		} else {
			
			log.warn("Unknown message from ObjectGripActor: " + JSON.stringify(response));
			
		}
	}
}
