import { Log } from '../util/log';
import { ExceptionBreakpoints, ThreadActorProxy } from '../firefox/index';

let log = Log.create('ThreadCoordinator');

enum ThreadState {
	Paused, Running, StepOver, StepIn, StepOut 
}

class QueuedRequest<T> {
	send: () => Promise<T>;
	resolve: (t: T) => void;
	reject: (err: any) => void;
}

/**
 * Requests that are sent to Firefox should be coordinated through this class:
 * - setting breakpoints and fetching stackframes and object properties must be run on a paused thread
 * - before the thread is resumed, the object grips that were fetched during the pause are released;
 *   no other requests should be sent to that thread between releasing and resuming, so they are
 *   queued to be sent later or rejected
 * - evaluate requests can only be sent when the thread is paused and resume the thread temporarily,
 *   so they must be sent sequentially
 */
export class ThreadCoordinator {
	
	constructor(private actor: ThreadActorProxy) {
		actor.onPaused((reason) => {
			this.desiredThreadState = ThreadState.Paused;
		});
		// The thread resumed unexpectedly, so we interrupt it again 
		actor.onResumed(() => {
			actor.interrupt();
		})
	}

	/**
	 * The user-visible state of the thread. It may be put in a different state temporarily
	 * in order to set breakpoints but will be put in the desired state when these requests 
	 * are finished.
	 */
	private desiredThreadState = ThreadState.Paused;
	
	/**
	 * Specifies if the thread should be interrupted when an exception occurs
	 */
	private exceptionBreakpoints: ExceptionBreakpoints;

	/**
	 * Queued tasks requiring the thread to be paused. These tasks are started using
	 * runOnPausedThread() and if the thread is currently resuming, they are put in this queue.
	 */
	private queuedtasksRunningOnPausedThread: QueuedRequest<any>[] = [];
			
	/**
	 * The number of tasks that are currently running requiring the thread to be paused. 
	 * These tasks are started using runOnPausedThread() and if the thread is running it will 
	 * automatically be paused temporarily.
	 */
	private tasksRunningOnPausedThread = 0;

	/**
	 * This function will resume the thread and is set by resume(). It will be called when all
	 * tasks that require the thread to be paused are finished
	 */
	private queuedResumeRequest: () => void;
	
	/**
	 * This flag specifies if the thread is currently being resumed
	 */
	private resumeRequestIsRunning = false;

	/**
	 * Evaluate requests queued to be run later
	 */	
	private queuedEvaluateRequests: QueuedRequest<[FirefoxDebugProtocol.Grip, Function]>[] = [];
	
	/**
	 * This flag specifies if an evaluate request is currently running
	 */
	private evaluateRequestIsRunning = false;
	
	/**
	 * Run a (possibly asynchronous) task on the paused thread.
	 * If the thread is not already paused, it will be paused temporarily and automatically 
	 * resumed when the task is finished (if there are no other reasons to pause the 
	 * thread). The task is passed a callback that must be invoked when the task is finished.
	 * If the thread is currently being resumed the task is either queued to be executed
	 * later or rejected, depending on the rejectOnResume flag.
	 */
	public runOnPausedThread<T>(task: (finished: () => void) => T | Promise<T>, rejectOnResume = true): Promise<T> {
		
		if (!this.resumeRequestIsRunning) {
			
			log.debug(`Starting task on paused thread (now running: ${this.tasksRunningOnPausedThread})`);
			this.tasksRunningOnPausedThread++;
			
			return new Promise<T>((resolve, reject) => {
				let result = this.actor.interrupt().then(
					() => task(() => this.taskFinished()));
				resolve(result);
			});
		
		} else if (!rejectOnResume) {

			log.debug('Queueing task to be run on paused thread');
			let resultPromise = new Promise<T>((resolve, reject) => {
				
				let send = () => {
					log.debug(`Starting task on paused thread (now running: ${this.tasksRunningOnPausedThread})`);
					this.tasksRunningOnPausedThread++;

					let result = this.actor.interrupt().then(
						() => task(() => this.taskFinished()));
					resolve(result);
					return result;
				};
				
				this.queuedtasksRunningOnPausedThread.push({ send, resolve, reject});
			});
			
			return resultPromise;
			
		} else {
			return Promise.reject('Resuming');
		}
	}

	public setExceptionBreakpoints(exceptionBreakpoints: ExceptionBreakpoints) {
		this.exceptionBreakpoints = exceptionBreakpoints;
		// the exceptionBreakpoints setting can only be sent to firefox when the thread is resumed,
		// so we start a dummy task that will pause the thread temporarily
		this.runOnPausedThread((finished) => finished());
	}
	
	public interrupt(): Promise<void> {
		return this.actor.interrupt(false).then(() => {
			this.desiredThreadState = ThreadState.Paused;
		});
	}
	
	/**
	 * Resume the thread (once all tasks that require the thread to be paused are finished).
	 * This will call the releaseResources function and wait until the returned Promise is
	 * resolved before sending the resume request to the thread.
	 */
	public resume(
		releaseResources: () => Promise<void>, 
		resumeLimit?: 'next' | 'step' | 'finish'): Promise<void> {
		
		return new Promise<void>((resolve, reject) => {
			
			this.queuedResumeRequest = () => {

				switch (resumeLimit) {
					case 'next':
						this.desiredThreadState = ThreadState.StepOver;
						break;
					case 'step':
						this.desiredThreadState = ThreadState.StepIn;
						break;
					case 'finish':
						this.desiredThreadState = ThreadState.StepOut;
						break;
					default:
						this.desiredThreadState = ThreadState.Running;
						break;
				}

				releaseResources()
				.then(() => this.actor.resume(this.exceptionBreakpoints, resumeLimit))
				.then(
					() => {
						this.resumeRequestIsRunning = false;
						resolve();
						this.doNext();
					},
					(err) => {
						this.resumeRequestIsRunning = false;
						reject();
						this.doNext();
					});
			};

			this.doNext();
		});
	}

	/**
	 * Evaluate the given expression on the specified StackFrame.
	 */
	public evaluate(expr: string, frameActorName: string): Promise<[FirefoxDebugProtocol.Grip, Function]> {
		return new Promise<[FirefoxDebugProtocol.Grip, Function]>((resolve, reject) => {

			let send = () => 
			this.actor.interrupt().then(() => 
			this.actor.evaluate(expr, frameActorName)).then(
				(grip) => <[FirefoxDebugProtocol.Grip, Function]>[grip, () => this.evaluateFinished()],
				(err) => { 
					this.evaluateFinished(); 
					throw err;
				});
			
			this.queuedEvaluateRequests.push({ send, resolve, reject });
			this.doNext();

		});
	}

	/**
	 * This method is called when a task started with runOnPausedThread() is finished.
	 */
	private taskFinished() {
		this.tasksRunningOnPausedThread--;
		log.debug(`Task finished on paused thread (remaining: ${this.tasksRunningOnPausedThread})`);
		this.doNext();
	}
	
	/**
	 * This method is called when an evaluateRequest is finished.
	 */
	private evaluateFinished() {
		log.debug('Evaluate finished');
		this.evaluateRequestIsRunning = false;
		this.doNext();
	}

	/**
	 * Figure out what to do next after some task is finished or has been enqueued.
	 */	
	private doNext() {
		
		if ((this.tasksRunningOnPausedThread > 0) || this.resumeRequestIsRunning) {
			return;
		}
		
		if (this.queuedtasksRunningOnPausedThread.length > 0) {
			
			this.queuedtasksRunningOnPausedThread.forEach((queuedTask) => queuedTask.send());
			this.queuedtasksRunningOnPausedThread = [];
			
		} else if (this.queuedResumeRequest) {

			this.resumeRequestIsRunning = true;
			let resumeRequest = this.queuedResumeRequest;
			this.queuedResumeRequest = null;
			resumeRequest();

		} else if ((this.queuedEvaluateRequests.length > 0) && !this.evaluateRequestIsRunning) {
			
			this.evaluateRequestIsRunning = true;
			let queuedEvaluateRequest = this.queuedEvaluateRequests.shift();
			queuedEvaluateRequest.send().then(
				([grip, finished]) => {
					queuedEvaluateRequest.resolve([grip, finished]);
					this.doNext();
				},
				(err) => {
					this.evaluateRequestIsRunning = false;
					queuedEvaluateRequest.reject(err);
					this.doNext();
				});

		} else {

			switch (this.desiredThreadState) {
				case ThreadState.Running:
					this.actor.resume(this.exceptionBreakpoints);
					break;
				case ThreadState.StepOver:
					this.actor.resume(this.exceptionBreakpoints, 'next');
					break;
				case ThreadState.StepIn:
					this.actor.resume(this.exceptionBreakpoints, 'step');
					break;
				case ThreadState.StepOut:
					this.actor.resume(this.exceptionBreakpoints, 'finish');
					break;
			}
		}
	}
}