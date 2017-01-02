import { Log } from '../util/log';
import { EventEmitter } from 'events';
import { ExceptionBreakpoints, ThreadActorProxy, ConsoleActorProxy } from '../firefox/index';
import { VariableAdapter } from './variable';
import { DelayedTask } from './delayedTask';
import { PendingRequest } from '../firefox/actorProxy/pendingRequests';

let log = Log.create('ThreadCoordinator');

type ThreadState = 'paused' | 'resuming' | 'running' | 'interrupting' | 'evaluating';

type ThreadTarget = 'paused' | 'running' | 'stepOver' | 'stepIn' | 'stepOut';

export class ThreadCoordinator extends EventEmitter {

	private exceptionBreakpoints: ExceptionBreakpoints;

	private threadState: ThreadState = 'paused';

	private threadTarget: ThreadTarget = 'paused';

	private interruptPromise?: Promise<void>;

	private queuedTasksToRunOnPausedThread: DelayedTask<any>[] = [];
	private tasksRunningOnPausedThread = 0;

	private queuedEvaluateTasks: DelayedTask<VariableAdapter>[] = [];
	private evaluateTaskIsRunning = false;

	constructor(private threadActor: ThreadActorProxy, private consoleActor: ConsoleActorProxy | undefined,
		private prepareResume: () => Promise<void>) {

		super();

		threadActor.onPaused((reason) => {
			if (this.threadState === 'evaluating') {
				threadActor.resume(this.exceptionBreakpoints);
			} else {
				this.threadState = 'paused';
				this.threadTarget = 'paused';
				this.interruptPromise = undefined;
				this.emit('paused', reason);
			}
		});

		threadActor.onResumed(() => {
			this.threadState = 'running';
			this.threadTarget = 'running';
			this.interruptPromise = undefined;
			if (this.tasksRunningOnPausedThread > 0) {
				log.warn('Thread resumed unexpectedly while tasks that need the thread to be paused were running');
			}
		});
	}

	public setExceptionBreakpoints(exceptionBreakpoints: ExceptionBreakpoints) {
		this.exceptionBreakpoints = exceptionBreakpoints;
		if ((this.threadState === 'resuming') || (this.threadState === 'running')) {
			this.runOnPausedThread(async () => undefined, undefined);
		}
	}

	public interrupt(): Promise<void> {

		if (this.threadState === 'paused') {

			return Promise.resolve();

		} else if (this.interruptPromise !== undefined) {

			return this.interruptPromise;

		} else {

			this.threadTarget = 'paused';
			this.doNext(); // this will set this.interruptPromise
			return this.interruptPromise!;

		}
	}

	public resume() {
		this.resumeTo('running');
	}

	public stepOver() {
		this.resumeTo('stepOver');
	}

	public stepIn() {
		this.resumeTo('stepIn');
	}

	public stepOut() {
		this.resumeTo('stepOut');
	}

	private resumeTo(target: 'running' | 'stepOver' | 'stepIn' | 'stepOut'): void {

		if (this.threadState === 'running') {
			if (target != 'running') {
				log.warn(`Can't ${target} because the thread is already running`);
			}
		} else {
			this.threadTarget = target;
		}

		this.doNext();
	}

	public runOnPausedThread<T>(mainTask: () => Promise<T>,
		postprocessingTask?: (result: T) => Promise<void>): Promise<T> {

		let delayedTask = new DelayedTask(mainTask, postprocessingTask);
		this.queuedTasksToRunOnPausedThread.push(delayedTask);
		this.doNext();
		return delayedTask.promise;
	}

	public evaluate(expr: string, frameActorName: string,
		convert: (grip: FirefoxDebugProtocol.Grip) => VariableAdapter,
		postprocess?: (result: VariableAdapter) => Promise<void>): Promise<VariableAdapter> {

		let evaluateTask = async () => {
			let grip = await this.threadActor.evaluate(expr, frameActorName);
			return convert(grip);
		};

		let delayedTask = new DelayedTask(evaluateTask, postprocess);

		this.queuedEvaluateTasks.push(delayedTask);
		this.doNext();

		return delayedTask.promise;
	}

	public consoleEvaluate(expr: string, frameActorName: string | undefined,
		convert: (grip: FirefoxDebugProtocol.Grip) => VariableAdapter,
		postprocess?: (result: VariableAdapter) => Promise<void>): Promise<VariableAdapter> {

		if (this.consoleActor === undefined) {
			throw new Error('This thread has no consoleActor');
		}

		let evaluateTask = async () => {
			let grip = await this.consoleActor!.evaluate(expr);
			return convert(grip);
		};

		let delayedTask = new DelayedTask(evaluateTask, postprocess);

		this.queuedEvaluateTasks.push(delayedTask);
		this.doNext();

		return delayedTask.promise;
	}

	public onPaused(cb: (reason: FirefoxDebugProtocol.ThreadPausedReason) => void) {
		this.on('paused', cb);
	}

	private doNext(): void {

		log.debug(`state: ${this.threadState}, target: ${this.threadTarget}, tasks: ${this.tasksRunningOnPausedThread}/${this.queuedTasksToRunOnPausedThread.length}, eval: ${this.queuedEvaluateTasks.length}`)

		if ((this.threadState === 'interrupting') ||
			(this.threadState === 'resuming') ||
			(this.threadState === 'evaluating')) {
			return;
		}

		if (this.threadState === 'running') {

			if ((this.queuedTasksToRunOnPausedThread.length > 0) || (this.queuedEvaluateTasks.length > 0)) {
				this.executeInterrupt(true);
				return;
			}
 
			if (this.threadTarget === 'paused') {
				this.executeInterrupt(false);
				return;
			}

		} else { // this.threadState === 'paused'

			if (this.queuedTasksToRunOnPausedThread.length > 0) {

				for (let task of this.queuedTasksToRunOnPausedThread) {
					this.executeOnPausedThread(task);
				}
				this.queuedTasksToRunOnPausedThread = [];

				return;
			}

			if (this.tasksRunningOnPausedThread > 0) {
				return;
			}

			if (this.queuedEvaluateTasks.length > 0) {

				let task = this.queuedEvaluateTasks.shift()!;
				this.executeEvaluateTask(task);

				return;
			}
		}

		if ((this.threadState === 'paused') && (this.threadTarget !== 'paused')) {
			this.executeResume();
			return;
		}
	}

	private async executeInterrupt(immediate: boolean): Promise<void> {

		this.threadState = 'interrupting';
		this.interruptPromise = this.threadActor.interrupt(immediate);

		try {
			await this.interruptPromise;
			this.threadState = 'paused';
		} catch(e) {
			log.error(`interrupt failed: ${e}`);
			this.threadState = 'running';
		}

		this.interruptPromise = undefined;

		this.doNext();
	}

	private async executeResume(): Promise<void> {

		let resumeLimit: 'next' | 'step' | 'finish' | undefined;
		switch (this.threadTarget) {
			case 'stepOver':
				resumeLimit = 'next';
				break;
			case 'stepIn':
				resumeLimit = 'step';
				break;
			case 'stepOut':
				resumeLimit = 'finish';
				break;
			default:
				resumeLimit = undefined;
				break;
		}

		this.threadState = 'resuming';
		try {
			await this.prepareResume();
			await this.threadActor.resume(this.exceptionBreakpoints, resumeLimit);
			this.threadState = 'running';
		} catch(e) {
			log.error(`resumeTask failed: ${e}`);
			this.threadState = 'paused';
		}

		this.doNext();
	}

	private async executeOnPausedThread(task: DelayedTask<any>): Promise<void> {

		if (this.threadState !== 'paused') {
			log.error(`executeOnPausedThread called but threadState is ${this.threadState}`);
			return;
		}

		this.tasksRunningOnPausedThread++;
		try {
			await task.execute();
		} catch(e) {
			log.warn(`task running on paused thread failed: ${e}`);
		}
		this.tasksRunningOnPausedThread--;

		if (this.tasksRunningOnPausedThread === 0) {
			this.doNext();
		}
	}

	private async executeEvaluateTask(task: DelayedTask<VariableAdapter>): Promise<void> {

		if (this.threadState !== 'paused') {
			log.error(`executeEvaluateTask called but threadState is ${this.threadState}`);
			return;
		}
		if (this.tasksRunningOnPausedThread > 0) {
			log.error(`executeEvaluateTask called but tasksRunningOnPausedThread is ${this.tasksRunningOnPausedThread}`);
			return;
		}

		this.threadState = 'evaluating';
		try {
			await task.execute();
		} catch(e) {
		}
		this.threadState = 'paused';

		this.doNext();
	}
}
