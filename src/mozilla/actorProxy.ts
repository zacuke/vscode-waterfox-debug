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

	public fetchTabs(): Promise<Map<string, TabActorProxy>> {
		return new Promise<Map<string, TabActorProxy>>((resolve, reject) => {
			this.pendingTabsRequests.enqueue({ resolve, reject });
			this.connection.sendRequest({ to: this.name, type: 'listTabs' });
		})
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

	public receiveResponse(response: MozDebugProtocol.Response): void {

		if (response['type'] === 'tabAttached') {

			let tabAttachedResponse = <MozDebugProtocol.TabAttachedResponse>response;
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
				this._url = (<MozDebugProtocol.TabWillNavigateResponse>response).url;
				this.emit('willNavigate');
			} else if (response['state'] === 'stop') {
				let didNavigateResponse = <MozDebugProtocol.TabDidNavigateResponse>response;
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

export class ThreadActorProxy extends EventEmitter implements ActorProxy {

	private pendingPauseRequests = new PendingRequests<PauseActorProxy>();
	private pendingDetachRequests = new PendingRequests<void>();
	private pendingSourceRequests = new PendingRequests<SourceActorProxy[]>();
	private pendingFrameRequests = new PendingRequests<MozDebugProtocol.Frame[]>();
	
	private knownToBePaused: boolean = false;
	
	constructor(private _name: string, private connection: MozDebugConnection) {
		super();
		this.connection.register(this);
	}

	public static createAndAttach(name: string, connection: MozDebugConnection): Promise<ThreadActorProxy> {
		let threadActor = new ThreadActorProxy(name, connection);
		return threadActor.attach().then(() => threadActor);
	}
	
	public get name() {
		return this._name;
	}

	public runOnPausedThread<T>(action: (resume: () => void) => (T | Thenable<T>)): Promise<T> {
		return new Promise<T>((resolve) => {
			if (this.knownToBePaused) {
				resolve(action(() => {}));
			} else {
				resolve(this.interrupt().then(() => {
					return action(() => this.resume());
				}));
			}
		});
	}
	
	private attach(): Promise<PauseActorProxy> {
		return new Promise<PauseActorProxy>((resolve, reject) => {
			this.pendingPauseRequests.enqueue({ resolve, reject });
			this.connection.sendRequest({ to: this.name, type: 'attach' });
		});
	}

	public interrupt(): Promise<PauseActorProxy> {
		return new Promise<PauseActorProxy>((resolve, reject) => {
			this.pendingPauseRequests.enqueue({ resolve, reject });
			this.connection.sendRequest({ to: this.name, type: 'interrupt' });
		});
	}

	public fetchSources(): Promise<SourceActorProxy[]> {
		return new Promise<SourceActorProxy[]>((resolve, reject) => {
			this.pendingSourceRequests.enqueue({ resolve, reject });
			this.connection.sendRequest({ to: this.name, type: 'sources' });
		});
	}
	
	public fetchStackFrames(): Promise<MozDebugProtocol.Frame[]> {
		return new Promise<MozDebugProtocol.Frame[]>((resolve, reject) => {
			this.pendingFrameRequests.enqueue({ resolve, reject });
			this.connection.sendRequest({ to: this.name, type: 'frames' });
		});
	}
	
	public resume(): void {
		this.knownToBePaused = false;
		this.connection.sendRequest({ to: this.name, type: 'resume' });
	}
	
	public stepOver(): void {
		this.knownToBePaused = false;
		this.connection.sendRequest({ to: this.name, type: 'resume', resumeLimit: { type: 'next' }});
	}
	
	public stepInto(): void {
		this.knownToBePaused = false;
		this.connection.sendRequest({ to: this.name, type: 'resume', resumeLimit: { type: 'step' }});
	}
	
	public stepOut(): void {
		this.knownToBePaused = false;
		this.connection.sendRequest({ to: this.name, type: 'resume', resumeLimit: { type: 'finish' }});
	}
	
	//TODO also detach the TabActorProxy(?)
	public detach(): Promise<void> {
		this.knownToBePaused = false;
		return new Promise<void>((resolve, reject) => {
			this.pendingDetachRequests.enqueue({ resolve, reject });
			this.connection.sendRequest({ to: this.name, type: 'detach' });
		});
	}
	
	public receiveResponse(response: MozDebugProtocol.Response): void {
		
		if (response['type'] === 'paused') {

			this.knownToBePaused = true;			
			let pausedResponse = <MozDebugProtocol.ThreadPausedResponse>response;
			let pauseActor = this.connection.getOrCreate(pausedResponse.actor,
				() => new PauseActorProxy(pausedResponse.actor, this.connection));
			this.pendingPauseRequests.resolveAll(pauseActor);
			this.pendingDetachRequests.rejectAll('paused');
			this.emit('paused', pausedResponse.why);

		} else if (response['type'] === 'exited') {
			
			this.pendingPauseRequests.rejectAll('exited');
			this.pendingDetachRequests.resolveAll(null);
			this.emit('exited');
			//TODO send release packet(?)
			
		} else if (response['error'] === 'wrongState') {
			
			this.pendingPauseRequests.rejectAll('wrongState');
			this.pendingDetachRequests.rejectAll('wrongState');
			this.emit('wrongState');
			
		} else if (response['type'] === 'detached') {
			
			this.pendingPauseRequests.rejectAll('detached');
			this.pendingDetachRequests.resolveAll(null);
			this.emit('detached');
			
		} else if (response['type'] === 'newSource') {
			
			let source = <MozDebugProtocol.Source>(response['source']);
			let sourceActor = this.connection.getOrCreate(source.actor, 
				() => new SourceActorProxy(source, this.connection));
			this.emit('newSource', sourceActor);
			
		} else if (response['sources']) {

			let sources = <MozDebugProtocol.Source[]>(response['sources']);
			let sourceActors = sources.map((source) => this.connection.getOrCreate(source.actor, 
				() => new SourceActorProxy(source, this.connection)));
			this.pendingSourceRequests.resolveOne(sourceActors);
			
		} else if (response['frames']) {

			let frames = <MozDebugProtocol.Frame[]>(response['frames']);
			this.pendingFrameRequests.resolveOne(frames);
			
		} else {

			if ((response['type'] !== 'newGlobal') && (response['type'] !== 'resumed')) {
				console.log("Unknown message from ThreadActor: ", JSON.stringify(response));
			}			

		}
			
	}
	
	public onPaused(cb: (why: string) => void) {
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
	
	public onNewSource(cb: (newSource: SourceActorProxy) => void) {
		this.on('newSource', cb);
	}
}

export class PauseActorProxy extends EventEmitter implements ActorProxy {

	constructor(private _name: string, private connection: MozDebugConnection) {
		super();
		this.connection.register(this);
	}

	public get name() {
		return this._name;
	}

	public receiveResponse(response: MozDebugProtocol.Response): void {
		
		console.log("Unknown message from PauseActor: ", JSON.stringify(response));
		
	}
}

export class SourceActorProxy extends EventEmitter implements ActorProxy {

	private pendingSetBreakpointRequests = new PendingRequests<SetBreakpointResult>();

	constructor(private _source: MozDebugProtocol.Source, private connection: MozDebugConnection) {
		super();
		this.connection.register(this);
	}

	public get name() {
		return this._source.actor;
	}

	public get url() {
		return this._source.url;
	}

	public setBreakpoint(location: MozDebugProtocol.SourceLocation): Promise<SetBreakpointResult> {
		return new Promise<SetBreakpointResult>((resolve, reject) => {
			this.pendingSetBreakpointRequests.enqueue({ resolve, reject });
			this.connection.sendRequest({ to: this.name, type: 'setBreakpoint', location: location });
		});
	}

	public receiveResponse(response: MozDebugProtocol.Response): void {
		
		if (response['isPending'] !== undefined) {
			
			//TODO actualLocation may be omitted!?
			//TODO create breakpointActor so that the breakpoint can be deleted
			let setBreakpointResponse = <MozDebugProtocol.SetBreakpointResponse>response;
			let actualLocation = setBreakpointResponse.actualLocation;
			let breakpointActor = this.connection.getOrCreate(setBreakpointResponse.actor,
				() => new BreakpointActorProxy(setBreakpointResponse.actor, this.connection));
			this.pendingSetBreakpointRequests.resolveOne(new SetBreakpointResult(breakpointActor, actualLocation));
			
		} else {
			
			console.log("Unknown message from SourceActor: ", JSON.stringify(response));
		
		}
	}
}

export class SetBreakpointResult {
	constructor(
		public breakpointActor: BreakpointActorProxy,
		public actualLocation: MozDebugProtocol.SourceLocation
	) {}
}

export class BreakpointActorProxy extends EventEmitter implements ActorProxy {

	private pendingDeleteRequests = new PendingRequests<void>();

	constructor(private _name: string, private connection: MozDebugConnection) {
		super();
		this.connection.register(this);
	}

	public get name() {
		return this._name;
	}

	public delete(): Promise<void> {
		return new Promise<void>((resolve, reject) => {
			this.pendingDeleteRequests.enqueue({ resolve, reject });
			this.connection.sendRequest({ to: this.name, type: 'delete' });
		});
	}

	public receiveResponse(response: MozDebugProtocol.Response): void {
		
		this.pendingDeleteRequests.resolveAll(null);
		
	}
}
