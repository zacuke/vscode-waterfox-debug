import { Log } from '../util/log';
import { ExceptionBreakpoints, ThreadActorProxy } from '../firefox/index';
import { VariableAdapter } from './variable';
import { DelayedTask } from './delayedTask';

let log = Log.create('ThreadCoordinator');

type ThreadState = 'paused' | 'resuming' | 'running' | 'interrupting' | 'evaluating';

export class ThreadCoordinator {

	private exceptionBreakpoints: ExceptionBreakpoints;

	private threadState: ThreadState = 'paused';

	private queuedInterruptTask?: DelayedTask<void> = undefined;
	private interruptPromise?: Promise<void> = undefined;
	private get isInterruptRequested(): boolean {
		return (this.interruptPromise !== undefined);
	}
	private get isInterrupting(): boolean {
		return (this.interruptPromise !== undefined) && (this.queuedInterruptTask === undefined);
	}

	private queuedResumeTask?: DelayedTask<void> = undefined;
	private resumePromise?: Promise<void> = undefined;
	private get isResumeRequested(): boolean {
		return (this.resumePromise !== undefined);
	}
	private get isResuming(): boolean {
		return (this.resumePromise !== undefined) && (this.queuedResumeTask === undefined);
	}

	private queuedTasksToRunOnPausedThread: DelayedTask<any>[] = [];
	private tasksRunningOnPausedThread = 0;

	private queuedEvaluateTasks: DelayedTask<VariableAdapter>[] = [];
	private evaluateTaskIsRunning = false;

	constructor(private actor: ThreadActorProxy) {

		actor.onPaused((reason) => {
			if (this.threadState === 'evaluating') {
				actor.resume(this.exceptionBreakpoints);
			} else {
				this.threadState = 'paused';
				this.queuedInterruptTask = undefined;
				this.interruptPromise = undefined;
				this.queuedResumeTask = undefined;
				this.resumePromise = undefined;
			}
		});

		actor.onResumed(() => {
			this.threadState = 'running';
			this.queuedInterruptTask = undefined;
			this.interruptPromise = undefined;
			this.queuedResumeTask = undefined;
			this.resumePromise = undefined;
			if (this.tasksRunningOnPausedThread > 0) {
				log.warn('Thread resumed unexpectedly while tasks that need the thread to be paused were running');
			}
		});
	}

	public setExceptionBreakpoints(exceptionBreakpoints: ExceptionBreakpoints) {
		this.exceptionBreakpoints = exceptionBreakpoints;
		if ((this.threadState === 'resuming') || (this.threadState === 'running')) {
			this.runOnPausedThread(async () => undefined, undefined, false);
		}
	}

	public interrupt(): Promise<void> {

		if (this.threadState === 'paused') {

			return Promise.resolve();

		} else if (this.isInterruptRequested) {

			return this.interruptPromise!;

		} else {

			this.queuedInterruptTask = new DelayedTask(() => this.actor.interrupt(false));
			this.interruptPromise = this.queuedInterruptTask.promise;

			this.doNext();

			return this.interruptPromise;

		}
	}

	public resume(
		releaseResourcesTask?: () => Promise<void>, 
		resumeLimit?: 'next' | 'step' | 'finish'): Promise<void> {

		if (this.threadState === 'running') {

			return Promise.resolve();

		} else if (this.isResumeRequested) {

			return this.resumePromise!;

		} else {

			this.queuedResumeTask = new DelayedTask(async () => {
				if (releaseResourcesTask !== undefined) {
					await releaseResourcesTask();
				}
				await this.actor.resume(this.exceptionBreakpoints, resumeLimit);
			});
			this.resumePromise = this.queuedResumeTask.promise;

			this.doNext();

			return this.resumePromise;

		}
	}

	public runOnPausedThread<T>(
		mainTask: () => Promise<T>,
		postprocessingTask?: (result: T) => Promise<void>,
		rejectIfResuming = true): Promise<T> {

		if (this.isResuming && rejectIfResuming) {
			return Promise.reject('Resuming');
		}

		let delayedTask = new DelayedTask(mainTask, postprocessingTask);
		this.queuedTasksToRunOnPausedThread.push(delayedTask);
		this.doNext();
		return delayedTask.promise;
	}

	public evaluate(expr: string, frameActorName: string,
		convert: (grip: FirefoxDebugProtocol.Grip) => VariableAdapter,
		postprocess: (result: VariableAdapter) => Promise<void>): Promise<VariableAdapter> {

		if ((this.threadState === 'resuming') || (this.threadState === 'running')) {
			return Promise.reject(`The thread is ${this.threadState}`);
		}

		let evaluateTask = async () => {
			let grip = await this.actor.evaluate(expr, frameActorName);
			return convert(grip);
		};

		let delayedTask = new DelayedTask(evaluateTask, postprocess);
		this.queuedEvaluateTasks.push(delayedTask);
		this.doNext();

		return delayedTask.promise;
	}

	private doNext(): void {

		log.debug(`state: ${this.threadState}, interrupt: ${this.isSet(this.queuedInterruptTask)}/${this.isSet(this.interruptPromise)}, resume: ${this.isSet(this.queuedResumeTask)}/${this.isSet(this.resumePromise)}, tasks: ${this.tasksRunningOnPausedThread}/${this.queuedTasksToRunOnPausedThread.length}, eval: ${this.queuedEvaluateTasks}`)

		if ((this.threadState === 'interrupting') ||
			(this.threadState === 'resuming') ||
			(this.threadState === 'evaluating')) {
			return;
		}

		if (this.queuedInterruptTask !== undefined) { // => this.threadState === 'running'
			this.executeInterruptTask();
			return;
		}

		if (this.queuedTasksToRunOnPausedThread.length > 0) {

			if (this.threadState === 'paused') {

				for (let task of this.queuedTasksToRunOnPausedThread) {
					this.executeOnPausedThread(task);
				}
				this.queuedTasksToRunOnPausedThread = [];

			} else { // => this.threadState === 'running'

				this.queuedInterruptTask = new DelayedTask(() => this.actor.interrupt(true));
				this.interruptPromise = this.queuedInterruptTask.promise;
				this.queuedResumeTask = new DelayedTask(() => this.actor.resume(this.exceptionBreakpoints));
				this.resumePromise = this.queuedResumeTask.promise;
				this.doNext();

			}
			return;
		}

		if (this.tasksRunningOnPausedThread > 0) {
			return;
		}

		if (this.queuedEvaluateTasks.length > 0) {

			if (this.threadState === 'paused') {

				let task = this.queuedEvaluateTasks.shift()!;
				this.executeEvaluateTask(task);

			} else { // => threadState === 'running'

				for (let task of this.queuedEvaluateTasks) {
					task.cancel(`Thread is ${this.threadState}`);
				}
				this.queuedEvaluateTasks = [];
				this.doNext();

			}
			return;
		}

		if (this.queuedResumeTask !== undefined) {
			this.executeResumeTask();
			return;
		}
	}

	private async executeInterruptTask(): Promise<void> {

		if (this.threadState !== 'running') {
			log.error(`executeInterruptTask called but threadState is ${this.threadState}`);
			return;
		}
		if (this.queuedInterruptTask === undefined) {
			log.error('executeInterruptTask called but there is no queuedInterruptTask');
			return;
		}

		let interruptTask = this.queuedInterruptTask;
		this.queuedInterruptTask = undefined;

		this.threadState = 'interrupting';
		try {
			await interruptTask.execute();
			this.threadState = 'paused';
		} catch(e) {
			log.error(`interruptTask failed: ${e}`);
			this.threadState = 'running';
		}

		this.interruptPromise = undefined;

		this.doNext();
	}

	private async executeResumeTask(): Promise<void> {

		if (this.threadState !== 'paused') {
			log.error(`executeResumeTask called but threadState is ${this.threadState}`);
			return;
		}
		if (this.tasksRunningOnPausedThread > 0) {
			log.error(`executeResumeTask called but tasksRunningOnPausedThread is ${this.tasksRunningOnPausedThread}`);
			return;
		}
		if (this.queuedResumeTask === undefined) {
			log.error('executeResumeTask called but there is no queuedResumeTask');
			return;
		}

		let resumeTask = this.queuedResumeTask;
		this.queuedResumeTask = undefined;

		this.threadState = 'resuming';
		try {
			await resumeTask.execute();
			this.threadState = 'running';
		} catch(e) {
			log.error(`resumeTask failed: ${e}`);
			this.threadState = 'paused';
		}

		this.resumePromise = undefined;

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
			log.warn(`evaluateTask failed: ${e}`);
		}
		this.threadState = 'paused';

		this.doNext();
	}

	private isSet(val: any): string {
		return (val === undefined) ? 'N' : 'Y';
	}
}
