import { EventEmitter } from 'events';
import { MozDebugConnection } from './mozDebugConnection';

/**
 * An ActorProxy is a client-side reference to an actor on the server side of the 
 * Mozilla Debugging Protocol as defined in https://wiki.mozilla.org/Remote_Debugging_Protocol
 */
export interface ActorProxy {
	name: string;
	receiveResponse(response: MozDebugProtocol.Response): void;
}

export class RootActorProxy extends EventEmitter implements ActorProxy {

	private tabs: Map<string, TabActorProxy>;

	constructor(private connection: any) {
		super();
		this.tabs = new Map<string, TabActorProxy>();
		this.connection.register(this);
	}

	public get name() {
		return 'root';
	}

	public receiveResponse(response: MozDebugProtocol.Response): void {

		if (response['applicationType']) {

			this.emit('init', response);

		} else if (response['tabs']) {

			let tabsResponse = <MozDebugProtocol.TabsResponse>response;

			// remove tabs that have disappeared and emit corresponding tabClosed events
			this.tabs.forEach((tabActor) => {
				if (!tabsResponse.tabs.some((tab) => (tab.actor === tabActor.name))) {
					this.emit('tabClosed', tabActor);
					this.tabs.delete(tabActor.name);
				}
			});

			// add new tabs and emit corresponding tabOpened events
			tabsResponse.tabs.forEach((tab) => {
				if (!this.tabs.has(tab.actor)) {
					let tabActor = new TabActorProxy(tab.actor, tab.title, tab.url, this.connection);
					this.tabs.set(tabActor.name, tabActor);
					this.emit('tabOpened', tabActor);
				}
			});

		} else if (response['type'] === 'tabListChanged') {

			this.fetchTabs();

		}
	}

	public fetchTabs() {
		this.connection.sendRequest({ to: this.name, type: 'listTabs' });
	}

	public onInit(cb: (response: MozDebugProtocol.InitialResponse) => void) {
		this.on('init', cb);
	}

	public onTabOpened(cb: (tabActor: TabActorProxy) => void) {
		this.on('tabOpened', cb);
	}

	public onTabClosed(cb: (tabActor: TabActorProxy) => void) {
		this.on('tabClosed', cb);
	}
}

export class TabActorProxy extends EventEmitter implements ActorProxy {

	private resolveAttachPromise: (threadActor: ThreadActorProxy) => void;
	private rejectAttachPromise: () => void;

	constructor(private _name: string, private _title: string, private _url: string, private connection: MozDebugConnection) {
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

	public receiveResponse(response: MozDebugProtocol.Response): void {

		if (response['type'] === 'tabAttached') {

			let tabAttachedResponse = <MozDebugProtocol.TabAttachedResponse>response;
			let threadActor = new ThreadActorProxy(tabAttachedResponse.threadActor, this.connection);
			this.emit('attached', threadActor);
			this.resolveAttachPromise(threadActor);
			this.resolveAttachPromise = null;
			this.rejectAttachPromise = null;

		} else if (response['type'] === 'exited') {

			this.rejectAttachPromise();
			this.resolveAttachPromise = null;
			this.rejectAttachPromise = null;

		} else if ((response['type'] === 'detached') || (response['type'] === 'tabDetached')) {

			this.emit('detached');

		} else if (response['type'] === 'tabNavigated') {

			if (response['state'] === 'start') {
				this._url = (<MozDebugProtocol.TabWillNavigateResponse>response).url;
				this.emit('willNavigate');
			} else if (response['state'] === 'stop') {
				let didNavigateResponse = <MozDebugProtocol.TabDidNavigateResponse>response;
				this._url = didNavigateResponse.url;
				this._title = didNavigateResponse.title;
				this.emit('didNavigate');
			}
		}
	}

	public attach(): Promise<ThreadActorProxy> {
		let promise = new Promise<ThreadActorProxy>((resolve, reject) => {
			this.resolveAttachPromise = resolve;
			this.rejectAttachPromise = reject;
		});
		this.connection.sendRequest({ to: this.name, type: 'attach' });
		return promise;
	}

	public detach(): void {
		this.connection.sendRequest({ to: this.name, type: 'detach' });
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

export class ThreadActorProxy implements ActorProxy {

	constructor(private _name: string, private connection: MozDebugConnection) {
		this.connection.register(this);
	}

	public get name() {
		return this._name;
	}

	public receiveResponse(response: MozDebugProtocol.Response): void {
	}
}