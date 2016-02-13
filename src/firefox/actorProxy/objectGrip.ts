import { Log } from '../../util/log';
import { EventEmitter } from 'events';
import { DebugConnection } from '../connection';
import { PendingRequests } from './pendingRequests';
import { ActorProxy } from './interface';

let log = Log.create('ObjectGripActorProxy');

export class ObjectGripActorProxy extends EventEmitter implements ActorProxy {
	
	private pendingPrototypeAndPropertiesRequests = new PendingRequests<FirefoxDebugProtocol.PrototypeAndPropertiesResponse>();

	constructor(private grip: FirefoxDebugProtocol.ObjectGrip, private connection: DebugConnection) {
		super();
		this.connection.register(this);
	}

	public get name() {
		return this.grip.actor;
	}

	public extendLifetime() {
		this.connection.sendRequest({ to: this.name, type: 'threadGrip' });
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
			
			log.debug('Received response to threadGrip or release request');
			
		} else {
			
			log.warn("Unknown message from ObjectGripActor: " + JSON.stringify(response));
			
		}
	}
}
