import { Log } from '../../util/log';
import { EventEmitter } from 'events';
import { DebugConnection } from '../connection';
import { PendingRequest, PendingRequests } from './pendingRequests';
import { ActorProxy } from './interface';
import { PauseActorProxy } from './pause';
import { SourceActorProxy } from './source';

/**
 * The possible states of a ThreadActorProxy
 */
enum State {
	/**
	 * The proxy is detached
	 */ 
	Detached, 
	
	/**
	 * The proxy is attached and the thread is probably running (although it may
	 * be paused and the proxy hasn't received the corresponding event yet)
	 */
	MaybeRunning, 
	
	/**
	 * The proxy is (about to be) attached and the thread is (about to be) paused. 
	 * It will only resume when resume() is called. 
	 * More precisely, the thread may still be detached or running but a request 
	 * has been sent to attach to or pause it. In any case, the thread will be 
	 * paused when it receives the next request.
	 */
	Paused,
	
	/**
	 * The proxy is attached and the thread is (about to be) paused to execute one
	 * or several operations passed to runOnPausedThread(). When all operations are 
	 * finished, it will be resumed (if the thread is still in this state).
	 * More precisely, the thread may still be running but a request has been sent
	 * to pause it. In any case, the thread will be paused when it receives the next
	 * request.
	 */
	PausedTemporarily 
}

/**
 * A ThreadActorProxy is a proxy for a "thread-like actor" (a Tab or a WebWorker)
 * in Firefox
 */
export class ThreadActorProxy extends EventEmitter implements ActorProxy {

	private state: State = State.Detached;
	private runningOperations = 0;
	private  get isPaused() : boolean { 
		return (this.state == State.Paused) || (this.state == State.PausedTemporarily); 
	}
	
	private pendingPauseRequest: PendingRequest<PauseActorProxy> = null;
	// pausePromise is set if and only if state is PausedTemporarily or Paused
	private pausePromise: Promise<PauseActorProxy> = null;
	
	private pendingSourceRequests = new PendingRequests<SourceActorProxy[]>();
	private pendingFrameRequests = new PendingRequests<FirefoxDebugProtocol.Frame[]>();
	
	constructor(private _name: string, private connection: DebugConnection) {
		super();
		this.connection.register(this);
	}

	/**
	 * Use this method to create a ThreadActorProxy and immediately attach it.
	 * The Promise returned by this method will be resolved when the created proxy finished
	 * attaching.
	 */
	public static createAndAttach(name: string, connection: DebugConnection): Promise<ThreadActorProxy> {

		let threadActor = new ThreadActorProxy(name, connection);

		return threadActor.attach().then(() => threadActor);
	}
	
	public get name() {
		return this._name;
	}

	public attach(): Promise<PauseActorProxy> {

		if (this.state != State.Detached) {
			return Promise.reject('Already attached');
		}
		
		Log.debug(`Attaching to thread ${this.name}`);

		this.state = State.Paused;

		return new Promise<PauseActorProxy>((resolve, reject) => {
			this.pendingPauseRequest = { resolve, reject };
			this.connection.sendRequest({ to: this.name, type: 'attach' });
		});
	}

	private sendPauseRequest(targetState: State): Promise<PauseActorProxy> {

		if (this.state != State.MaybeRunning) {
			return Promise.reject('Detached or already paused');
		}
		if ((targetState != State.PausedTemporarily) && (targetState != State.Paused)) {
			return Promise.reject('Detached or already paused');
		}
		
		this.pausePromise = new Promise<PauseActorProxy>((resolve, reject) => {
			this.pendingPauseRequest = { resolve, reject };
			this.connection.sendRequest({ to: this.name, type: 'interrupt' });
		});
		
		return this.pausePromise;
	}
	
	/**
	 * Run a (possibly asynchronous) operation on the paused thread.
	 * If the thread is not already paused, it will be paused temporarily and automatically
	 * resumed when the operation is finished (if there are no other requests to pause the
	 * thread). The operation is passed a callback that it must call when it is finished.
	 */
	public runOnPausedThread<T>(operation: (finished: () => void) => (T | Thenable<T>)): Promise<T> {

		if (this.state == State.Detached) {
			return Promise.reject('Detached');
		}
		
		return new Promise<T>((resolve) => {
			
			this.runningOperations++;
			
			if (this.state == State.MaybeRunning) {

				this.sendPauseRequest(State.PausedTemporarily).then(() => {
					resolve(operation(() => this.operationFinished()));
				});
			
			} else {
				
				resolve(operation(() => this.operationFinished()));
				
			}
		});
	}
	
	private operationFinished() {

		this.runningOperations--;

		if ((this.state == State.PausedTemporarily) && (this.runningOperations == 0)) {
			this.resume();
		}
	}

	/**
	 * Interrupt the thread. If it is paused already, the promise returned by this method
	 * will already be resolved.
	 */	
	public interrupt(): Promise<PauseActorProxy> {

		if (this.state == State.Detached) {
			return Promise.reject('Detached');
		}
		
		Log.debug(`Interrupting thread ${this.name}`);

		if (this.state == State.MaybeRunning) {

			return this.sendPauseRequest(State.Paused);
			
		} else {
			
			return this.pausePromise.then((pauseActor) => {
				this.state = State.Paused;
				return pauseActor;
			});
			
		}
	}

	public fetchSources(): Promise<SourceActorProxy[]> {

		if (!this.isPaused) {
			return Promise.reject('not paused');
		}
		
		Log.debug(`Fetching sources from thread ${this.name}`);

		return new Promise<SourceActorProxy[]>((resolve, reject) => {
			this.pendingSourceRequests.enqueue({ resolve, reject });
			this.connection.sendRequest({ to: this.name, type: 'sources' });
		});
	}
	
	public fetchStackFrames(): Promise<FirefoxDebugProtocol.Frame[]> {

		if (!this.isPaused) {
			return Promise.reject('not paused');
		}
		
		Log.debug(`Fetching stackframes from thread ${this.name}`);

		return new Promise<FirefoxDebugProtocol.Frame[]>((resolve, reject) => {
			this.pendingFrameRequests.enqueue({ resolve, reject });
			this.connection.sendRequest({ to: this.name, type: 'frames' });
		});
	}
	
	public resume(): void {

		if (!this.isPaused) {
			return;
		}
		
		Log.debug(`Resuming thread ${this.name}`);

		if (this.runningOperations == 0) {

			this.state = State.MaybeRunning;
			this.connection.sendRequest({ to: this.name, type: 'resume' });

		} else {
			
			this.state = State.PausedTemporarily;
			
		}
	}
	
	public stepOver(): void {

		if (!this.isPaused) {
			return;
		}
		
		Log.debug(`Stepping - thread ${this.name}`);

		if (this.runningOperations == 0) {

			this.state = State.MaybeRunning;
			this.connection.sendRequest({ to: this.name, type: 'resume', resumeLimit: { type: 'next' }});

		} else {
			
			this.state = State.PausedTemporarily;
			
		}
	}
	
	public stepInto(): void {

		if (!this.isPaused) {
			return;
		}
		
		Log.debug(`Stepping in - thread ${this.name}`);

		if (this.runningOperations == 0) {

			this.state = State.MaybeRunning;
			this.connection.sendRequest({ to: this.name, type: 'resume', resumeLimit: { type: 'step' }});

		} else {
			
			this.state = State.PausedTemporarily;
			
		}
	}
	
	public stepOut(): void {

		if (!this.isPaused) {
			return;
		}
		
		Log.debug(`Stepping out - thread ${this.name}`);

		if (this.runningOperations == 0) {

			this.state = State.MaybeRunning;
			this.connection.sendRequest({ to: this.name, type: 'resume', resumeLimit: { type: 'finish' }});

		} else {
			
			this.state = State.PausedTemporarily;
			
		}
	}
	
	//TODO also detach the TabActorProxy(?)
	public detach(): void {

		Log.debug(`Detaching from thread ${this.name}`);

		this.state = State.Detached;

		this.connection.sendRequest({ to: this.name, type: 'detach' });
	}
	
	
	public receiveResponse(response: FirefoxDebugProtocol.Response): void {
		
		if (response['type'] === 'paused') {

			Log.debug(`Thread ${this.name} paused`);

			let pausedResponse = <FirefoxDebugProtocol.ThreadPausedResponse>response;
			let pauseActor = this.connection.getOrCreate(pausedResponse.actor,
				() => new PauseActorProxy(pausedResponse.actor, this.connection));
			
			switch (pausedResponse.why.type) {
				case 'attached':
				case 'interrupted':
					if (this.state != State.Paused) {
						Log.error(`Received paused event with reason ${pausedResponse.why.type}, but proxy is in state ${this.state}`);
						return;
					}
					
					if (this.pendingPauseRequest != null) {
						this.pendingPauseRequest.resolve(pauseActor);
						this.pendingPauseRequest = null;
					} else {
						Log.error(`Received paused event with reason ${pausedResponse.why.type}, but there is no pending pause request`)
					}
					
					break;
					
				case 'resumeLimit':
					if (this.state != State.MaybeRunning) {
						Log.error(`Received paused event with reason ${pausedResponse.why.type}, but proxy is in state ${this.state}`);
						return;
					}
					
					break;

				case 'breakpoint':
					if (this.state != State.MaybeRunning) {
						Log.error(`Received paused event with reason ${pausedResponse.why.type}, but proxy is in state ${this.state}`);
						return;
					}
					
					this.state = State.Paused;
					
					break;
					
				case 'debuggerStatement':
				case 'watchpoint':
				case 'clientEvaluated':
				case 'pauseOnDOMEvents':
					Log.error(`Paused event with reason ${pausedResponse.why.type} not handled yet`);
					break;
			}
			
			this.emit('paused', pausedResponse.why.type);

		} else if (response['type'] === 'exited') {
			
			Log.debug(`Thread ${this.name} exited`);

			if (this.pendingPauseRequest != null) {
				this.pendingPauseRequest.reject('Exited');
			}
			this.pausePromise = null;
			this.pendingSourceRequests.rejectAll('Exited');
			this.pendingFrameRequests.rejectAll('Exited');
			
			this.state = State.Detached;
			
			this.emit('exited');
			//TODO send release packet(?)
			
		} else if (response['error'] === 'wrongState') {

			Log.warn(`Thread ${this.name} was in the wrong state for the last request`);

			//TODO reject last request!
			
			this.emit('wrongState');
			
		} else if (response['type'] === 'detached') {
			
			Log.debug(`Thread ${this.name} detached`);
			
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
				Log.debug(`Received newGlobal event from ${this.name} (ignoring)`);
			} else if (response['type'] === 'resumed') {
				Log.debug(`Received resumed event from ${this.name} (ignoring)`);
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

	public onNewSource(cb: (newSource: SourceActorProxy) => void) {
		this.on('newSource', cb);
	}
}
