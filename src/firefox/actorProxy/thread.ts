import { Log } from '../../util/log';
import { EventEmitter } from 'events';
import { DebugConnection } from '../connection';
import { PendingRequests } from './pendingRequests';
import { ActorProxy } from './interface';
import { PauseActorProxy } from './pause';
import { SourceActorProxy } from './source';

export class ThreadActorProxy extends EventEmitter implements ActorProxy {

	private pendingPauseRequests = new PendingRequests<PauseActorProxy>();
	private pendingDetachRequests = new PendingRequests<void>();
	private pendingSourceRequests = new PendingRequests<SourceActorProxy[]>();
	private pendingFrameRequests = new PendingRequests<FirefoxDebugProtocol.Frame[]>();
	
	private knownToBePaused: boolean = false;
	
	constructor(private _name: string, private connection: DebugConnection) {
		super();
		this.connection.register(this);
	}

	public static createAndAttach(name: string, connection: DebugConnection): Promise<ThreadActorProxy> {
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

		Log.debug(`Attaching to thread ${this.name}`);

		return new Promise<PauseActorProxy>((resolve, reject) => {
			this.pendingPauseRequests.enqueue({ resolve, reject });
			this.connection.sendRequest({ to: this.name, type: 'attach' });
		});
	}

	public interrupt(): Promise<PauseActorProxy> {

		Log.debug(`Interrupting thread ${this.name}`);

		return new Promise<PauseActorProxy>((resolve, reject) => {
			this.pendingPauseRequests.enqueue({ resolve, reject });
			this.connection.sendRequest({ to: this.name, type: 'interrupt' });
		});
	}

	public fetchSources(): Promise<SourceActorProxy[]> {

		Log.debug(`Fetching sources from thread ${this.name}`);

		return new Promise<SourceActorProxy[]>((resolve, reject) => {
			this.pendingSourceRequests.enqueue({ resolve, reject });
			this.connection.sendRequest({ to: this.name, type: 'sources' });
		});
	}
	
	public fetchStackFrames(): Promise<FirefoxDebugProtocol.Frame[]> {

		Log.debug(`Fetching stackframes from thread ${this.name}`);

		return new Promise<FirefoxDebugProtocol.Frame[]>((resolve, reject) => {
			this.pendingFrameRequests.enqueue({ resolve, reject });
			this.connection.sendRequest({ to: this.name, type: 'frames' });
		});
	}
	
	public resume(): void {

		Log.debug(`Resuming thread ${this.name}`);

		this.knownToBePaused = false;
		this.connection.sendRequest({ to: this.name, type: 'resume' });
	}
	
	public stepOver(): void {

		Log.debug(`Stepping - thread ${this.name}`);

		this.knownToBePaused = false;
		this.connection.sendRequest({ to: this.name, type: 'resume', resumeLimit: { type: 'next' }});
	}
	
	public stepInto(): void {

		Log.debug(`Stepping in - thread ${this.name}`);

		this.knownToBePaused = false;
		this.connection.sendRequest({ to: this.name, type: 'resume', resumeLimit: { type: 'step' }});
	}
	
	public stepOut(): void {

		Log.debug(`Stepping out - thread ${this.name}`);

		this.knownToBePaused = false;
		this.connection.sendRequest({ to: this.name, type: 'resume', resumeLimit: { type: 'finish' }});
	}
	
	//TODO also detach the TabActorProxy(?)
	public detach(): Promise<void> {

		Log.debug(`Detaching from thread ${this.name}`);

		this.knownToBePaused = false;
		return new Promise<void>((resolve, reject) => {
			this.pendingDetachRequests.enqueue({ resolve, reject });
			this.connection.sendRequest({ to: this.name, type: 'detach' });
		});
	}
	
	public receiveResponse(response: FirefoxDebugProtocol.Response): void {
		
		if (response['type'] === 'paused') {

			Log.debug(`Thread ${this.name} paused`);

			this.knownToBePaused = true;			
			let pausedResponse = <FirefoxDebugProtocol.ThreadPausedResponse>response;
			let pauseActor = this.connection.getOrCreate(pausedResponse.actor,
				() => new PauseActorProxy(pausedResponse.actor, this.connection));
			this.pendingPauseRequests.resolveAll(pauseActor);
			this.pendingDetachRequests.rejectAll('paused');
			this.emit('paused', pausedResponse.why);

		} else if (response['type'] === 'exited') {
			
			Log.debug(`Thread ${this.name} exited`);

			this.pendingPauseRequests.rejectAll('exited');
			this.pendingDetachRequests.resolveAll(null);
			this.emit('exited');
			//TODO send release packet(?)
			
		} else if (response['error'] === 'wrongState') {

			Log.warn(`Thread ${this.name} was in the wrong state for the last request`);

			this.pendingPauseRequests.rejectAll('wrongState');
			this.pendingDetachRequests.rejectAll('wrongState');
			this.emit('wrongState');
			
		} else if (response['type'] === 'detached') {
			
			Log.debug(`Thread ${this.name} detached`);

			this.pendingPauseRequests.rejectAll('detached');
			this.pendingDetachRequests.resolveAll(null);
			this.emit('detached');
			
		} else if (response['type'] === 'newSource') {
			
			let source = <FirefoxDebugProtocol.Source>(response['source']);

			Log.debug(`New source ${source.url} on thread ${this.name}`);

			let sourceActor = this.connection.getOrCreate(source.actor, 
				() => new SourceActorProxy(source, this.connection));
			this.emit('newSource', sourceActor);
			
		} else if (response['sources']) {

			let sources = <FirefoxDebugProtocol.Source[]>(response['sources']);

			Log.debug(`Received ${sources.length} sources from thread ${this.name}`);

			let sourceActors = sources.map((source) => this.connection.getOrCreate(source.actor, 
				() => new SourceActorProxy(source, this.connection)));
			this.pendingSourceRequests.resolveOne(sourceActors);
			
		} else if (response['frames']) {

			let frames = <FirefoxDebugProtocol.Frame[]>(response['frames']);

			Log.debug(`Received ${frames.length} frames from thread ${this.name}`);

			this.pendingFrameRequests.resolveOne(frames);
			
		} else {

			if (response['type'] === 'newGlobal') {
				Log.debug(`Ignored newGlobal event from ${this.name}`);
			} else if (response['type'] === 'resumed') {
				Log.debug(`Ignored resumed event from ${this.name}`);
			} else {
				Log.warn("Unknown message from ThreadActor: " + JSON.stringify(response));
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
