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

class PendingRequest<T> {
	resolve: (t: T) => void;
	reject: (err: any) => void;
}

class PendingRequests<T> {
	
	private pendingRequests: PendingRequest<T>[] = [];
	
	public enqueue(req: PendingRequest<T>) {
		this.pendingRequests.push(req);
	}
	
	public resolveOne(t: T) {
		if (this.pendingRequests.length > 0) {
			let request = this.pendingRequests.shift();
			request.resolve(t);
		} else {
			console.log("Received response without corresponding request!?");
		}
	}
	
	public rejectOne(err: any) {
		if (this.pendingRequests.length > 0) {
			let request = this.pendingRequests.shift();
			request.reject(err);
		} else {
			console.log("Received error response without corresponding request!?");
		}
	}
	
	public resolveAll(t: T) {
		this.pendingRequests.forEach((req) => req.resolve(t));
		this.pendingRequests = [];
	}
	
	public rejectAll(err: any) {
		this.pendingRequests.forEach((req) => req.reject(err));
		this.pendingRequests = [];
	}
}

export class RootActorProxy extends EventEmitter implements ActorProxy {

	private tabs = new Map<string, TabActorProxy>();
	private pendingTabsRequests = new PendingRequests<Map<string, TabActorProxy>>();
	
	constructor(private connection: any) {
		super();
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
			this.pendingTabsRequests.resolveOne(currentTabs);
			
		} else if (response['type'] === 'tabListChanged') {

			this.emit('tabListChanged');

		} else {
			
			console.log("Unknown message from RootActor: ", JSON.stringify(response));
			
		}
	}

	public fetchTabs(): Promise<Map<string, TabActorProxy>> {
		return new Promise<Map<string, TabActorProxy>>((resolve, reject) => {
			this.pendingTabsRequests.enqueue({ resolve, reject });
			this.connection.sendRequest({ to: this.name, type: 'listTabs' });
		})
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

export class TabActorProxy extends EventEmitter implements ActorProxy {

	private pendingAttachRequests = new PendingRequests<ThreadActorProxy>();
	private pendingDetachRequests = new PendingRequests<void>();

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
			this.pendingAttachRequests.resolveOne(threadActor);

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

export class ThreadActorProxy extends EventEmitter implements ActorProxy {

	private pendingAttachRequests = new PendingRequests<void>();
	private pendingDetachRequests = new PendingRequests<void>();

	constructor(private _name: string, private connection: MozDebugConnection) {
		super();
		this.connection.register(this);
	}

	public get name() {
		return this._name;
	}

	public receiveResponse(response: MozDebugProtocol.Response): void {
		
		if (response['type'] === 'paused') {
			
			// TODO look at 'why'; what about a PauseActor?
			console.log('Paused: ' + JSON.stringify(response));
			this.pendingAttachRequests.resolveAll(null);
			this.pendingDetachRequests.rejectAll('paused');
			this.emit('paused');

		} else if (response['type'] === 'exited') {
			
			this.pendingAttachRequests.rejectAll('exited');
			this.pendingDetachRequests.resolveAll(null);
			this.emit('exited');
			//TODO send release packet(?)
			
		} else if (response['error'] === 'wrongState') {
			
			this.pendingAttachRequests.rejectAll('wrongState');
			this.pendingDetachRequests.rejectAll('wrongState');
			this.emit('wrongState');
			
		} else if (response['type'] === 'detached') {
			
			this.pendingAttachRequests.rejectAll('detached');
			this.pendingDetachRequests.resolveAll(null);
			this.emit('detached');
			
		} else {
			
			console.log("Unknown message from ThreadActor: ", JSON.stringify(response));

		}
			
	}
	
	public attach(): void {
		this.connection.sendRequest({ to: this.name, type: 'attach' });
	}
	
	public detach(): void {
		this.connection.sendRequest({ to: this.name, type: 'detach' });
	}
	
	public onPaused(cb: () => void) {
		this.on('paused', cb);
	}

	public onExited(cb: () => void) {
		this.on('exited', cb);
	}

	public onWrongState(cb: () => void) {
		this.on('wrongState', cb);
	}

	public onDetached(cb: () => void) {
		this.on('detached', cb);
	}
}