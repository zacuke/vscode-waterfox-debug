import { EventEmitter } from 'events';
import { DebugConnection } from '../connection';
import { PendingRequests } from './pendingRequests';
import { ActorProxy } from './interface';
import { ThreadActorProxy } from './thread';

export class TabActorProxy extends EventEmitter implements ActorProxy {

	private pendingAttachRequests = new PendingRequests<ThreadActorProxy>();
	private pendingDetachRequests = new PendingRequests<void>();

	constructor(private _name: string, private _title: string, private _url: string, private connection: DebugConnection) {
		super();
		this.connection.register(this);
	}

	public get name() {
		return this._name;
	}

	public get title() {
		return this._title;
	}

	public get url() {
		return this._url;
	}

	public attach(): Promise<ThreadActorProxy> {
		return new Promise<ThreadActorProxy>((resolve, reject) => {
			this.pendingAttachRequests.enqueue({ resolve, reject });
			this.connection.sendRequest({ to: this.name, type: 'attach' });
		});
	}

	public detach(): Promise<void> {
		return new Promise<void>((resolve, reject) => {
			this.pendingDetachRequests.enqueue({ resolve, reject });
			this.connection.sendRequest({ to: this.name, type: 'detach' });
		});
	}

	public receiveResponse(response: FirefoxDebugProtocol.Response): void {

		if (response['type'] === 'tabAttached') {

			let tabAttachedResponse = <FirefoxDebugProtocol.TabAttachedResponse>response;
			let threadActorPromise = this.connection.getOrCreatePromise(tabAttachedResponse.threadActor, 
				() => ThreadActorProxy.createAndAttach(tabAttachedResponse.threadActor, this.connection));
			threadActorPromise.then((threadActor) => {
				this.emit('attached', threadActor);
				this.pendingAttachRequests.resolveOne(threadActor);
			});

		} else if (response['type'] === 'exited') {

			this.pendingAttachRequests.rejectOne("exited");

		} else if (response['type'] === 'detached') {

			this.pendingDetachRequests.resolveOne(null);
			this.emit('detached');

		} else if (response['error'] === 'wrongState') {

			this.pendingDetachRequests.rejectOne("exited");

		} else if (response['type'] === 'tabDetached') {

			// TODO handle pendingRequests
			this.emit('tabDetached');

		} else if (response['type'] === 'tabNavigated') {

			if (response['state'] === 'start') {
				this._url = (<FirefoxDebugProtocol.TabWillNavigateResponse>response).url;
				this.emit('willNavigate');
			} else if (response['state'] === 'stop') {
				let didNavigateResponse = <FirefoxDebugProtocol.TabDidNavigateResponse>response;
				this._url = didNavigateResponse.url;
				this._title = didNavigateResponse.title;
				this.emit('didNavigate');
			}

		} else {
			
			if (response['type'] !== 'frameUpdate') {
				console.log("Unknown message from TabActor: ", JSON.stringify(response));
			}
			
		}
	}

	public onAttached(cb: (threadActor: ThreadActorProxy) => void) {
		this.on('attached', cb);
	}

	public onDetached(cb: () => void) {
		this.on('detached', cb);
	}

	public onWillNavigate(cb: () => void) {
		this.on('willNavigate', cb);
	}

	public onDidNavigate(cb: () => void) {
		this.on('didNavigate', cb);
	}
}
