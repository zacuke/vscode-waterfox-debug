import { Log } from '../util/log';

let log = Log.create('DelayedTask');

export class DelayedTask<T> {

	private state: 'waiting' | 'running' | 'postprocessing' | 'finished';
	private resolve: (result: T) => void;
	private reject: (reason?: any) => void;

	public readonly promise: Promise<T>;

	public constructor(
		private mainTask: () => Promise<T>,
		private postprocessTask?: (result: T) => Promise<void>) {

		this.promise = new Promise<T>((resolve, reject) => {
			this.resolve = resolve;
			this.reject = reject;
		});
		this.state = 'waiting';
	}

	public async execute(): Promise<void> {

		if (this.state !== 'waiting') {
			log.error(`Tried to execute DelayedTask, but it is ${this.state}`);
			return;
		}

		let result: T;
		try {
			this.state = 'running';
			result = await this.mainTask();
			this.resolve(result);
		} catch (err) {
			this.reject(err);
			throw err;
		}

		if (this.postprocessTask) {
			this.state = 'postprocessing';
			await this.postprocessTask(result);
		}

		this.state = 'finished';
	}

	public cancel(reason?: any): void {

		if (this.state !== 'waiting') {
			log.error(`Tried to cancel DelayedTask, but it is ${this.state}`);
			return;
		}

		this.reject(reason);
		this.state = 'finished';
	}
}
