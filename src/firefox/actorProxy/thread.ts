import { Log } from '../../util/log';
import { EventEmitter } from 'events';
import { DebugConnection } from '../connection';
import { PendingRequest, PendingRequests } from '../../util/pendingRequests';
import { ActorProxy } from './interface';
import { ISourceActorProxy, SourceActorProxy } from './source';
import { exceptionGripToString } from '../../util/misc';

let log = Log.create('ThreadActorProxy');

export interface IThreadActorProxy {
	name: string;
	attach(useSourceMaps?: boolean): Promise<void>;
	resume(exceptionBreakpoints: ExceptionBreakpoints, resumeLimitType?: 'next' | 'step' | 'finish'): Promise<void>;
	interrupt(immediately?: boolean): Promise<void>;
	detach(): Promise<void>;
	fetchSources(): Promise<FirefoxDebugProtocol.Source[]>;
	fetchStackFrames(start?: number, count?: number): Promise<FirefoxDebugProtocol.Frame[]>;
	evaluate(expression: string, frameActorName: string): Promise<FirefoxDebugProtocol.Grip>;
	threadGrips(objectGripActorNames: string[]): Promise<void>;
	releaseMany(objectGripActorNames: string[]): Promise<void>;
	onPaused(cb: (reason: FirefoxDebugProtocol.ThreadPausedReason) => void): void;
	onResumed(cb: () => void): void;
	onExited(cb: () => void): void;
	onWrongState(cb: () => void): void;
	onNewSource(cb: (newSource: ISourceActorProxy) => void): void;
	dispose(): void;
}

export enum ExceptionBreakpoints {
	All, Uncaught, None
}

/**
 * A ThreadActorProxy is a proxy for a "thread-like actor" (a Tab or a WebWorker) in Firefox. 
 */
export class ThreadActorProxy extends EventEmitter implements ActorProxy, IThreadActorProxy {

	constructor(private _name: string, private connection: DebugConnection) {
		super();
		this.connection.register(this);
		log.debug(`Created thread ${this.name}`);
	}

	public get name() {
		return this._name;
	}

	private pendingAttachRequest?: PendingRequest<void>;
	private attachPromise?: Promise<void>;
	private pendingResumeRequest?: PendingRequest<void>;
	private resumePromise?: Promise<void>;
	private pendingInterruptRequest?: PendingRequest<void>;
	private interruptPromise?: Promise<void>;
	private pendingDetachRequest?: PendingRequest<void>;
	private detachPromise?: Promise<void>;
	
	private pendingSourcesRequests = new PendingRequests<FirefoxDebugProtocol.Source[]>();
	private pendingStackFramesRequests = new PendingRequests<FirefoxDebugProtocol.Frame[]>();
	private pendingEvaluateRequest?: PendingRequest<FirefoxDebugProtocol.Grip>;
	private pendingThreadGripsRequests = new PendingRequests<void>();
	
	/**
	 * Attach the thread if it is detached
	 */
	public attach(useSourceMaps = true): Promise<void> {
		if (!this.attachPromise) {
			log.debug(`Attaching thread ${this.name}`);

			this.attachPromise = new Promise<void>((resolve, reject) => {
				this.pendingAttachRequest = { resolve, reject };
				this.connection.sendRequest({ 
					to: this.name, type: 'attach', 
					options: { useSourceMaps }
				});
			});
			this.detachPromise = undefined;
			
		} else {
			log.warn('Attaching this thread has already been requested!');
		}
		
		return this.attachPromise;
	}
	
	/**
	 * Resume the thread if it is paused
	 */
	public resume(exceptionBreakpoints: ExceptionBreakpoints, resumeLimitType?: 'next' | 'step' | 'finish'): Promise<void> {
		if (!this.resumePromise) {
			log.debug(`Resuming thread ${this.name}`);

			let resumeLimit = resumeLimitType ? { type: resumeLimitType } : undefined;
			let pauseOnExceptions: boolean | undefined = undefined;
			let ignoreCaughtExceptions: boolean | undefined = undefined;
			switch (exceptionBreakpoints) {
				case ExceptionBreakpoints.All:
					pauseOnExceptions = true;
					break;

				case ExceptionBreakpoints.Uncaught:
					pauseOnExceptions = true;
					ignoreCaughtExceptions = true;
					break;
			}

			this.resumePromise = new Promise<void>((resolve, reject) => {
				this.pendingResumeRequest = { resolve, reject };
				this.connection.sendRequest({ 
					to: this.name, type: 'resume', 
					resumeLimit, pauseOnExceptions, ignoreCaughtExceptions
				});
			});
			this.interruptPromise = undefined;

		}

		return this.resumePromise;
	}
	
	/**
	 * Interrupt the thread if it is running
	 */
	public interrupt(immediately = true): Promise<void> {
		if (!this.interruptPromise) {
			log.debug(`Interrupting thread ${this.name}`);

			this.interruptPromise = new Promise<void>((resolve, reject) => {
				this.pendingInterruptRequest = { resolve, reject };
				this.connection.sendRequest({
					to: this.name, type: 'interrupt',
					when: immediately ? undefined : 'onNext'
				});
			});
			this.resumePromise = undefined;
			
		}
		
		return this.interruptPromise;
	}
	
	/**
	 * Detach the thread if it is attached
	 */
	public detach(): Promise<void> {
		if (!this.detachPromise) {
			log.debug(`Detaching thread ${this.name}`);

			this.detachPromise = new Promise<void>((resolve, reject) => {
				this.pendingDetachRequest = { resolve, reject };
				this.connection.sendRequest({ to: this.name, type: 'detach' });
			});
			this.attachPromise = undefined;
			
		} else {
			log.warn('Detaching this thread has already been requested!');
		}
		
		return this.detachPromise;
	}

	/**
	 * Fetch the list of source files. This will also cause newSource events to be emitted for
	 * every source file (including those that are loaded later and strings passed to eval())
	 */
	public fetchSources(): Promise<FirefoxDebugProtocol.Source[]> {
		log.debug(`Fetching sources from thread ${this.name}`);

		return new Promise<FirefoxDebugProtocol.Source[]>((resolve, reject) => {
			this.pendingSourcesRequests.enqueue({ resolve, reject });
			this.connection.sendRequest({ to: this.name, type: 'sources' });
		});
	}

	/**
	 * Fetch StackFrames. This can only be called while the thread is paused.
	 */
	public fetchStackFrames(start?: number, count?: number): Promise<FirefoxDebugProtocol.Frame[]> {
		log.debug(`Fetching stackframes from thread ${this.name}`);

		return new Promise<FirefoxDebugProtocol.Frame[]>((resolve, reject) => {
			this.pendingStackFramesRequests.enqueue({ resolve, reject });
			this.connection.sendRequest({ 
				to: this.name, type: 'frames', 
				start, count
			});
		});
	}

	/**
	 * Evaluate the given expression on the specified StackFrame. This can only be called while
	 * the thread is paused and will resume it temporarily.
	 */
	public evaluate(expression: string, frameActorName: string): Promise<FirefoxDebugProtocol.Grip> {
		log.debug(`Evaluating '${expression}' on thread ${this.name}`);
		
		return new Promise<FirefoxDebugProtocol.Grip>((resolve, reject) => {
			if (this.pendingEvaluateRequest) {
				let err = 'Another evaluateRequest is already running'; 
				log.error(err);
				reject(err);
				return;
			}
			if (!this.interruptPromise) {
				let err = 'Can\'t evaluate because the thread isn\'t paused';
				log.error(err);
				reject(err);
				return;
			}
			
			this.pendingEvaluateRequest = { resolve, reject };
			this.resumePromise = new Promise<void>((resolve, reject) => {
				this.pendingResumeRequest = { resolve, reject };
			});
			this.interruptPromise = undefined;

			this.connection.sendRequest({ 
				to: this.name, type: 'clientEvaluate', expression, frame: frameActorName 
			});
		});
	}

	public threadGrips(objectGripActorNames: string[]): Promise<void> {
		log.debug(`Extending lifetime of grips on thread ${this.name}`);
		
		return new Promise<void>((resolve, reject) => {
			this.pendingThreadGripsRequests.enqueue({ resolve, reject });
			this.connection.sendRequest({
				to: this.name, type: 'threadGrips',
				actors: objectGripActorNames 
			});
		});
	}

	/**
	 * Release object grips that were promoted to thread-lifetime grips using 
	 * ObjectGripActorProxy.extendLifetime(). This can only be called while the thread is paused.
	 */
	public releaseMany(objectGripActorNames: string[]): Promise<void> {
		log.debug(`Releasing grips on thread ${this.name}`);
		
		return new Promise<void>((resolve, reject) => {
			this.pendingThreadGripsRequests.enqueue({ resolve, reject });
			this.connection.sendRequest({ 
				to: this.name, type: 'releaseMany',
				actors: objectGripActorNames 
			});
		});
	}

	public dispose(): void {
		this.connection.unregister(this);
	}

	public receiveResponse(response: FirefoxDebugProtocol.Response): void {
		
		if (response['type'] === 'paused') {

			let pausedResponse = <FirefoxDebugProtocol.ThreadPausedResponse>response;
			log.debug(`Received paused message of type ${pausedResponse.why.type}`);
			
			switch (pausedResponse.why.type) {
				case 'attached':
					if (this.pendingAttachRequest) {
						this.pendingAttachRequest.resolve(undefined);
						this.pendingAttachRequest = undefined;
						this.interruptPromise = Promise.resolve(undefined);
					} else {
						log.warn('Received attached message without pending request');
					}
					break;

				case 'interrupted':
				case 'alreadyPaused':
					if (this.pendingInterruptRequest) {
						this.pendingInterruptRequest.resolve(undefined);
						this.pendingInterruptRequest = undefined;
					} else if (pausedResponse.why.type !== 'alreadyPaused') {
						log.warn(`Received ${pausedResponse.why.type} message without pending request`);
					}
					break;

				case 'resumeLimit':
				case 'breakpoint':
				case 'exception':
				case 'debuggerStatement':
					if (this.pendingInterruptRequest) {
						this.pendingInterruptRequest.resolve(undefined);
						this.pendingInterruptRequest = undefined;
					} else {
						this.interruptPromise = Promise.resolve(undefined);
					}
					if (this.pendingResumeRequest) {
						this.pendingResumeRequest.reject(`Hit ${pausedResponse.why.type}`);
						this.pendingResumeRequest = undefined;
					}
					this.resumePromise = undefined;
					this.emit('paused', pausedResponse.why);
					break;

				case 'clientEvaluated':
					this.interruptPromise = Promise.resolve(undefined);
					this.resumePromise = undefined;
					if (this.pendingEvaluateRequest) {
						//TODO handle undefined frameFinished and return!
						let completionValue = pausedResponse.why.frameFinished!;
						if (completionValue.return !== undefined) {
							this.pendingEvaluateRequest.resolve(completionValue.return!);
						} else {
							this.pendingEvaluateRequest.reject(exceptionGripToString(completionValue.throw));
						}
						this.pendingEvaluateRequest = undefined;
					} else {
						log.warn('Received clientEvaluated message without pending request');
					}
					break;

				default:
					log.warn(`Paused event with reason ${pausedResponse.why.type} not handled yet`);
					this.emit('paused', pausedResponse.why);
					break;
			}

		} else if (response['type'] === 'resumed') {

			if (this.pendingResumeRequest) {
				log.debug(`Received resumed event from ${this.name}`);
				this.pendingResumeRequest.resolve(undefined);
				this.pendingResumeRequest = undefined;
			} else {
				log.debug(`Received unexpected resumed event from ${this.name}`);
				this.interruptPromise = undefined;
				this.resumePromise = Promise.resolve(undefined);
				this.emit('resumed');
			}
			
		} else if (response['type'] === 'detached') {
			
			log.debug(`Thread ${this.name} detached`);
			if (this.pendingDetachRequest) {
				this.pendingDetachRequest.resolve(undefined);
				this.pendingDetachRequest = undefined;
			} else {
				log.warn(`Thread ${this.name} detached without a corresponding request`);
			}

			this.pendingStackFramesRequests.rejectAll('Detached');
			if (this.pendingEvaluateRequest) {
				this.pendingEvaluateRequest.reject('Detached');
				this.pendingEvaluateRequest = undefined;
			}
			
		} else if (response['sources']) {

			let sources = <FirefoxDebugProtocol.Source[]>(response['sources']);
			log.debug(`Received ${sources.length} sources from thread ${this.name}`);
			this.pendingSourcesRequests.resolveOne(sources);

		} else if (response['type'] === 'newSource') {
			
			let source = <FirefoxDebugProtocol.Source>(response['source']);
			log.debug(`New source ${source.url} on thread ${this.name}`);
			let sourceActor = this.connection.getOrCreate(source.actor, 
				() => new SourceActorProxy(source, this.connection));
			this.emit('newSource', sourceActor);
			
		} else if (response['frames']) {

			let frames = <FirefoxDebugProtocol.Frame[]>(response['frames']);
			log.debug(`Received ${frames.length} frames from thread ${this.name}`);
			this.pendingStackFramesRequests.resolveOne(frames);
			
		} else if (response['type'] === 'exited') {
			
			log.debug(`Thread ${this.name} exited`);
			this.emit('exited');
			//TODO send release packet(?)
			
		} else if (response['error'] === 'wrongState') {

			log.warn(`Thread ${this.name} was in the wrong state for the last request`);
			//TODO reject last request!
			this.emit('wrongState');
			
		} else if (response['error'] === 'wrongOrder') {

			log.warn(`got wrongOrder error: ${response['message']}`);
			this.resumePromise = undefined;
			if (this.pendingResumeRequest) {
				this.pendingResumeRequest.reject(`You need to resume ${response['lastPausedUrl']} first`);
			}

		} else if (response['error'] === 'noSuchActor') {
			
			log.error(`No such actor ${JSON.stringify(this.name)}`);
			if (this.pendingAttachRequest) {
				this.pendingAttachRequest.reject('No such actor');
			}
			if (this.pendingDetachRequest) {
				this.pendingDetachRequest.reject('No such actor');
			}
			if (this.pendingInterruptRequest) {
				this.pendingInterruptRequest.reject('No such actor');
			}
			if (this.pendingResumeRequest) {
				this.pendingResumeRequest.reject('No such actor');
			}
			this.pendingSourcesRequests.rejectAll('No such actor');
			this.pendingStackFramesRequests.rejectAll('No such actor');
			if (this.pendingEvaluateRequest) {
				this.pendingEvaluateRequest.reject('No such actor');
				this.pendingEvaluateRequest = undefined;
			}
			this.pendingThreadGripsRequests.rejectAll('No such actor');

		} else if (response['error'] === 'notReleasable') {

			log.warn('Error releasing threadGrips; this is probably due to Firefox bug #1249962');
			this.pendingThreadGripsRequests.rejectOne('Not releasable');

		} else if (response['error'] === 'unknownFrame') {

			let errorMsg = response['message']
			log.error(`Error evaluating expression: ${errorMsg}`);
			if (this.pendingEvaluateRequest) {
				this.pendingEvaluateRequest.reject(errorMsg);
				this.pendingEvaluateRequest = undefined;
			}

		} else if (Object.keys(response).length === 1) {

			log.debug('Received response to threadGrips/releaseMany request');
			this.pendingThreadGripsRequests.resolveOne(undefined);

		} else {

			if (response['type'] === 'newGlobal') {
				log.debug(`Received newGlobal event from ${this.name} (ignoring)`);
			} else if (response['type'] === 'willInterrupt') {
				log.debug(`Received willInterrupt event from ${this.name} (ignoring)`);
			} else {
				log.warn("Unknown message from ThreadActor: " + JSON.stringify(response));
			}			

		}
			
	}

	/**
	 * The paused event is only sent when the thread is paused because it hit a breakpoint or a
	 * resumeLimit, but not if it was paused due to an interrupt request or because an evaluate
	 * request is finished
	 */	
	public onPaused(cb: (reason: FirefoxDebugProtocol.ThreadPausedReason) => void) {
		this.on('paused', cb);
	}

	/**
	 * The resumed event is only sent when the thread is resumed without a corresponding request
	 * (this happens when a tab in Firefox is reloaded or navigated to a different url while 
	 * the corresponding thread is paused)
	 */
	public onResumed(cb: () => void) {
		this.on('resumed', cb);
	}
	
	public onExited(cb: () => void) {
		this.on('exited', cb);
	}

	public onWrongState(cb: () => void) {
		this.on('wrongState', cb);
	}

	public onNewSource(cb: (newSource: ISourceActorProxy) => void) {
		this.on('newSource', cb);
	}
}
