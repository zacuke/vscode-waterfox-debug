import { Log } from '../../util/log';
import { EventEmitter } from 'events';
import { DebugConnection } from '../connection';
import { PendingRequests } from './pendingRequests';
import { ActorProxy } from './interface';

export class ObjectGripActorProxy extends EventEmitter implements ActorProxy {
	
	private pendingPrototypeAndPropertiesRequests = new PendingRequests<FirefoxDebugProtocol.PrototypeAndPropertiesResponse>();

	constructor(private grip: FirefoxDebugProtocol.ObjectGrip, private connection: DebugConnection) {
		super();
		this.connection.register(this);
	}

	public get name() {
		return this.grip.actor;
	}

	public fetchPrototypeAndProperties(): Promise<FirefoxDebugProtocol.PrototypeAndPropertiesResponse> {
		return new Promise<FirefoxDebugProtocol.PrototypeAndPropertiesResponse>((resolve, reject) => {
			this.pendingPrototypeAndPropertiesRequests.enqueue({ resolve, reject });
			this.connection.sendRequest({ to: this.name, type: 'prototypeAndProperties' });
		});
	}
	
	public receiveResponse(response: FirefoxDebugProtocol.Response): void {

		if ((response['prototype'] !== undefined) && (response['ownProperties'] !== undefined)) {
			
			this.pendingPrototypeAndPropertiesRequests.resolveOne(<FirefoxDebugProtocol.PrototypeAndPropertiesResponse>response);
			
		} else {
			
			Log.warn("Unknown message from ObjectGripActor: " + JSON.stringify(response));
			
		}
	}
}
