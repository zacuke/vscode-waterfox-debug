import { Log } from '../../util/log';
import { EventEmitter } from 'events';
import { DebugConnection } from '../connection';
import { PendingRequests } from './pendingRequests';
import { ActorProxy } from './interface';
import { ThreadActorProxy } from './thread';

let log = Log.create('TabActorProxy');

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

		log.debug(`Attaching to tab ${this.name}`);

		return new Promise<ThreadActorProxy>((resolve, reject) => {
			this.pendingAttachRequests.enqueue({ resolve, reject });
			this.connection.sendRequest({ to: this.name, type: 'attach' });
		});
	}

	public detach(): Promise<void> {

		log.debug(`Detaching from tab ${this.name}`);

		return new Promise<void>((resolve, reject) => {
			this.pendingDetachRequests.enqueue({ resolve, reject });
			this.connection.sendRequest({ to: this.name, type: 'detach' });
		});
	}

	public receiveResponse(response: FirefoxDebugProtocol.Response): void {

		if (response['type'] === 'tabAttached') {

			log.debug(`Attached to tab ${this.name}`);
			let tabAttachedResponse = <FirefoxDebugProtocol.TabAttachedResponse>response;
			let threadActor = this.connection.getOrCreate(tabAttachedResponse.threadActor, 
				() => new ThreadActorProxy(tabAttachedResponse.threadActor, this.connection));
			this.emit('attached', threadActor);
			this.pendingAttachRequests.resolveOne(threadActor);

		} else if (response['type'] === 'exited') {

			log.debug(`Tab ${this.name} exited`);
			this.pendingAttachRequests.rejectOne("exited");

		} else if (response['type'] === 'detached') {

			log.debug(`Detached from tab ${this.name} as requested`);
			this.pendingDetachRequests.resolveOne(null);

		} else if (response['error'] === 'wrongState') {

			log.warn(`Tab ${this.name} was in the wrong state for the last request`);
			this.pendingDetachRequests.rejectOne("exited");

		} else if (response['type'] === 'tabDetached') {

			log.debug(`Detached from tab ${this.name} because it was closed`);
			// TODO handle pendingRequests
			this.emit('detached');

		} else if (response['type'] === 'tabNavigated') {

			if (response['state'] === 'start') {

				this._url = (<FirefoxDebugProtocol.TabWillNavigateResponse>response).url;
				log.debug(`Tab ${this.name} will navigate to ${this._url}`);
				this.emit('willNavigate');
				
			} else if (response['state'] === 'stop') {

				let didNavigateResponse = <FirefoxDebugProtocol.TabDidNavigateResponse>response;
				this._url = didNavigateResponse.url;
				this._title = didNavigateResponse.title;
				log.debug(`Tab ${this.name} did navigate to ${this._url}`);
				this.emit('didNavigate');

			}

		} else if (response['error'] === 'noSuchActor') {
			
			log.error(`No such actor ${JSON.stringify(this.name)}`);
			this.pendingAttachRequests.rejectAll('No such actor');
			this.pendingDetachRequests.rejectAll('No such actor');

		} else {
			
			if (response['type'] === 'frameUpdate') {
				log.debug(`Ignored frameUpdate event from tab ${this.name}`);
			} else {
				log.warn("Unknown message from TabActor: " + JSON.stringify(response));
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
