import { Log } from '../../util/log';
import { EventEmitter } from 'events';
import { DebugConnection } from '../connection';
import { PendingRequests } from './pendingRequests';
import { ActorProxy } from './interface';

let log = Log.create('ConsoleActorProxy');

export class ConsoleActorProxy extends EventEmitter implements ActorProxy {

	private static listenFor = ['PageError', 'ConsoleAPI'];

	private pendingStartListenersRequests = new PendingRequests<void>();
	private pendingStopListenersRequests = new PendingRequests<void>();

	constructor(private _name: string, private connection: DebugConnection) {
		super();
		this.connection.register(this);
	}

	public get name() {
		return this._name;
	}

	public startListeners(): Promise<void> {
		log.debug('Starting console listeners');

		return new Promise<void>((resolve, reject) => {
			this.pendingStartListenersRequests.enqueue({ resolve, reject });
			this.connection.sendRequest({ 
				to: this.name, type: 'startListeners',
				listeners: ConsoleActorProxy.listenFor
			});
		});
	}

	public stopListeners(): Promise<void> {
		log.debug('Stopping console listeners');

		return new Promise<void>((resolve, reject) => {
			this.pendingStopListenersRequests.enqueue({ resolve, reject });
			this.connection.sendRequest({ 
				to: this.name, type: 'stopListeners',
				listeners: ConsoleActorProxy.listenFor
			});
		});
	}

	public receiveResponse(response: FirefoxDebugProtocol.Response): void {

		if (response['startedListeners']) {

			log.debug('Listeners started');
			this.pendingStartListenersRequests.resolveOne(null);

		} else if (response['stoppedListeners']) {

			log.debug('Listeners stopped');
			this.pendingStartListenersRequests.resolveOne(null);

		} else if (response['type'] === 'consoleAPICall') {

			log.debug(`Received ConsoleAPI message`);
			this.emit('consoleAPI', (<FirefoxDebugProtocol.ConsoleAPICallResponse>response).message);

		} else if (response['type'] === 'pageError') {

			log.debug(`Received PageError message`);
			this.emit('pageError', (<FirefoxDebugProtocol.PageErrorResponse>response).pageError);

		} else {

			log.warn("Unknown message from ConsoleActor: " + JSON.stringify(response));

		}
	}

	public onConsoleAPICall(cb: (body: FirefoxDebugProtocol.ConsoleAPICallResponseBody) => void) {
		this.on('consoleAPI', cb);
	}

	public onPageErrorCall(cb: (body: FirefoxDebugProtocol.PageErrorResponseBody) => void) {
		this.on('pageError', cb);
	}
}
