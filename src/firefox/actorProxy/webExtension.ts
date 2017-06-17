import { Log } from '../../util/log';
import { EventEmitter } from 'events';
import { PendingRequests } from './pendingRequests';
import { ActorProxy } from './interface';
import { TabActorProxy } from './tab';
import { ConsoleActorProxy } from './console';
import { DebugConnection } from "../connection";

let log = Log.create('WebExtensionActorProxy');

export class WebExtensionActorProxy extends EventEmitter implements ActorProxy {

	private pendingConnectRequests = new PendingRequests<[TabActorProxy, ConsoleActorProxy]>();

	constructor(
		private readonly webExtensionInfo: FirefoxDebugProtocol.Addon,
		private sourceMaps: 'client' | 'server',
		private readonly connection: DebugConnection
	) {
		super();
		this.connection.register(this);
	}

	public get name() {
		return this.webExtensionInfo.actor;
	}

	public connect(): Promise<[TabActorProxy, ConsoleActorProxy]> {

		log.debug('Connecting');

		return new Promise<[TabActorProxy, ConsoleActorProxy]>((resolve, reject) => {
			this.pendingConnectRequests.enqueue({ resolve, reject });
			this.connection.sendRequest({ to: this.name, type: 'connect' });
		})
	}

	public receiveResponse(response: FirefoxDebugProtocol.Response): void {

		if (response['form']) {

			let connectResponse = <FirefoxDebugProtocol.ProcessResponse>response;
			log.debug('Received connect response');
			this.pendingConnectRequests.resolveOne([
				new TabActorProxy(
					connectResponse.form.actor, this.webExtensionInfo.name, connectResponse.form.url,
					this.sourceMaps, this.connection),
				new ConsoleActorProxy(connectResponse.form.consoleActor, this.connection)
			]);

		} else {

			log.warn("Unknown message from WebExtensionActor: " + JSON.stringify(response));

		}
	}
}
