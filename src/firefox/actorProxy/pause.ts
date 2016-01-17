import { Log } from '../../util/log';
import { EventEmitter } from 'events';
import { DebugConnection } from '../connection';
import { ActorProxy } from './interface';

export class PauseActorProxy extends EventEmitter implements ActorProxy {

	constructor(private _name: string, private connection: DebugConnection) {
		super();
		this.connection.register(this);
	}

	public get name() {
		return this._name;
	}

	public receiveResponse(response: FirefoxDebugProtocol.Response): void {
		
		Log.warn("Unknown message from PauseActor: " + JSON.stringify(response));
		
	}
}
