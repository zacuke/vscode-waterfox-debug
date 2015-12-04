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
	private pendingTabsRequests: PendingRequest<Map<string, TabActorProxy>>[];
	
	constructor(private connection: any) {
		super();
		this.tabs = new Map<string, TabActorProxy>();
		this.pendingTabsRequests = [];
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
			let currentTabs = new Map<string, TabActorProxy>();
			
			// convert the Tab array int a map of TabActorProxies, re-using already 
			// existing proxies and emitting tabOpened events for new ones
			tabsResponse.tabs.forEach((tab) => {
				let tabActor: TabActorProxy;
				if (this.tabs.has(tab.actor)) {
					tabActor = this.tabs.get(tab.actor);
				} else {
					tabActor = new TabActorProxy(tab.actor, tab.title, tab.url, this.connection);
					this.emit('tabOpened', tabActor);
				}
				currentTabs.set(tab.actor, tabActor);
			});

			// emit tabClosed events for tabs that have disappeared
			this.tabs.forEach((tabActor) => {
				if (!currentTabs.has(tabActor.name)) {
					this.emit('tabClosed', tabActor);
				}
			});					

			this.tabs = currentTabs;
			if (this.pendingTabsRequests.length > 0) {
				let tabsRequest = this.pendingTabsRequests.shift();
				tabsRequest.resolve(currentTabs);
			} else {
				console.error("Received tabs response without a request!?");
			}
			
		} else if (response['type'] === 'tabListChanged') {

			this.emit('tabListChanged');

		} else {
			
			console.log("Unknown message from RootActor: ", JSON.stringify(response));
			
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

	public onTabListChanged(cb: () => void) {
		this.on('tabListChanged', cb);
	}
}

class PendingRequest<T> {
	resolve: (t: T) => {};
	reject: (err: MozDebugProtocol.ErrorResponse) => {};
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

		} else {
			
			console.log("Unknown message from TabActor: ", JSON.stringify(response));
			
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
			
		console.log("Unknown message from ThreadActor: ", JSON.stringify(response));
			
	}
}