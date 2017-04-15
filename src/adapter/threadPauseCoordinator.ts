import { Log } from '../util/log';
import { PendingRequest } from '../firefox/actorProxy/pendingRequests';

let log = Log.create('ThreadPauseCoordinator');

export type PauseType = 'auto' | 'user';

export class ThreadPauseCoordinator {

	private currentPauses: ThreadPauseInfo[] = [];
	private requestedPauses: PendingThreadPauseRequest[] = [];
	private requestedResumes: PendingThreadResumeRequest[] = [];
	private interruptingThread?: ThreadPauseInfo;
	private resumingThread?: ThreadInfo;

	public requestInterrupt(threadId: number, threadName: string, pauseType: PauseType): Promise<void> {

		if (log.isDebugEnabled()) {
			log.debug(`Requesting ${pauseType} interrupt for ${threadName}`);
		}

		if (this.findPauseIndex(threadId) !== undefined) {
			log.warn(`Requesting ${threadName} to be interrupted but it seems to be paused already`);
			return Promise.resolve(undefined);
		}

		let promise = new Promise<void>((resolve, reject) => {
			let pendingRequest = { resolve, reject };
			this.requestedPauses.push({ threadId, threadName, pauseType, pendingRequest });
		});

		this.doNext();

		return promise;
	}

	public requestResume(threadId: number, threadName: string): Promise<void> {

		if (log.isDebugEnabled()) {
			log.debug(`Requesting resume for ${threadName}`);
		}

		let pause: ThreadPauseInfo | undefined;
		if ((this.interruptingThread !== undefined) && (this.interruptingThread.threadId == threadId)) {

			pause = this.interruptingThread;

		} else {

			let pauseIndex = this.findPauseIndex(threadId);
			if (pauseIndex !== undefined) {
				pause = this.currentPauses[pauseIndex];
			}
		}

		if (pause === undefined) {
			log.warn(`Requesting ${threadName} to be resumed but it doesn't seem to be paused`);
			return Promise.resolve();
		}

		if (pause.pauseType === 'user') {
			let hinderingPauses = this.findHinderingPauses(threadId);
			if (hinderingPauses.length > 0) {
				let msg = `${threadName} can't be resumed because you need to resume ${hinderingPauses.map((pauseInfo) => pauseInfo.threadName).join(', ')} first`;
				log.info(msg);
				return Promise.reject(msg);
			}
		}

		let promise = new Promise<void>((resolve, reject) => {
			let pendingRequest = { resolve, reject };
			this.requestedResumes.push({ threadId, threadName, pendingRequest });
		});

		this.doNext();

		return promise;
	}

	public notifyInterrupted(threadId: number, threadName: string, pauseType: PauseType): void {

		if (log.isDebugEnabled()) {
			log.debug(`${threadName} interrupted, type ${pauseType}`);
		}

		if ((this.interruptingThread !== undefined) && (this.interruptingThread.threadId === threadId)) {
			this.interruptingThread = undefined;
		}

		if (this.findPauseIndex(threadId) === undefined) {

			this.currentPauses.push({ threadId, threadName, pauseType });

			if ((this.interruptingThread !== undefined) || (this.resumingThread !== undefined)) {
				log.warn(`Received paused notification from ${threadName} while waiting for a notification from another thread`);
			}
		}

		this.doNext();
	}

	public notifyInterruptFailed(threadId: number, threadName: string): void {

		if (log.isDebugEnabled()) {
			log.debug(`Interrupting ${threadName} failed`);
		}

		if ((this.interruptingThread !== undefined) && (this.interruptingThread.threadId === threadId)) {
			this.interruptingThread = undefined;
		}
	}

	public notifyResumed(threadId: number, threadName: string): void {

		if (log.isDebugEnabled()) {
			log.debug(`${threadName} resumed`);
		}

		let pauseIndex = this.findPauseIndex(threadId);

		if (pauseIndex === undefined) {

			log.warn(`Received resumed notification from ${threadName} but it doesn't seem to be paused`);

		} else if (pauseIndex === this.currentPauses.length - 1) {

			this.currentPauses.pop();

		} else {

			log.warn(`Received resumed notification from ${threadName} even though it is not the most recently paused thread`);
			this.currentPauses.splice(pauseIndex, 1);

		}

		if ((this.resumingThread !== undefined) && (this.resumingThread.threadId === threadId)) {
			this.resumingThread = undefined;
		} 

		if ((this.interruptingThread !== undefined) || (this.resumingThread !== undefined)) {
			log.warn(`Received resumed notification from ${threadName} while waiting for a notification from another thread`);
		}

		this.doNext();
	}

	public notifyResumeFailed(threadId: number, threadName: string): void {

		if (log.isDebugEnabled()) {
			log.debug(`Resuming ${threadName} failed`);
		}

		if ((this.resumingThread !== undefined) && (this.resumingThread.threadId === threadId)) {
			this.resumingThread = undefined;
		} 
	}

	public threadTerminated(threadId: number, threadName: string) {

		if (log.isDebugEnabled()) {
			log.debug(`Removing ${threadName}`);
		}
		
		if (this.interruptingThread && (this.interruptingThread.threadId === threadId)) {
			this.interruptingThread = undefined;
		}
		
		if (this.resumingThread && (this.resumingThread.threadId === threadId)) {
			this.resumingThread = undefined;
		}

		this.requestedPauses = this.requestedPauses.filter((pauseRequest) => {
			if (pauseRequest.threadId === threadId) {
				pauseRequest.pendingRequest.reject('Thread terminated');
				return false;
			}
			return true;
		});

		this.requestedResumes = this.requestedResumes.filter((requestedResume) => {
			if (requestedResume.threadId === threadId) {
				requestedResume.pendingRequest.reject('Thread terminated');
				return false;
			}
			return true;
		});

		this.currentPauses = this.currentPauses.filter(
			(currentPause) => (currentPause.threadId !== threadId));

		this.doNext();
	}

	private doNext(): void {

		if (log.isDebugEnabled()) {
			let msg = '';

			if (this.interruptingThread !== undefined) {
				msg += `Interrupting ${this.interruptingThread.threadName}, `;
			}

			if (this.resumingThread !== undefined) {
				msg += `Resuming ${this.resumingThread.threadName}, `;
			}

			msg += `current pauses: [${
				this.currentPauses.map((info) => info.threadName + '/' + info.pauseType).join(',')
			}], requested pauses: [${
				this.requestedPauses.map((info) => info.threadName + '/' + info.pauseType).join(',')
			}], requested resumes: [${
				this.requestedResumes.map((info) => info.threadName).join(',')
			}]`;

			log.debug(msg);
		}

		if ((this.interruptingThread !== undefined) || (this.resumingThread !== undefined)) {
			return;
		}

		if (this.currentPauses.length > 0) {

			let mostRecentPause = this.currentPauses[this.currentPauses.length - 1];

			let resumeRequestIndex = this.findResumeRequestIndex(mostRecentPause.threadId);
			if (resumeRequestIndex !== undefined) {
				this.resumeThread(resumeRequestIndex);
				return;
			}

			if (mostRecentPause.pauseType === 'auto') {

				let automaticPauseRequestIndex = this.findAutomaticPauseRequestIndex();
				if (automaticPauseRequestIndex !== undefined) {
					this.pauseThread(automaticPauseRequestIndex);
				}

				return;
			}
		}

		//TODO should we block requested pauses if there is a resume waiting?
		if (this.requestedPauses.length > 0) {
			this.pauseThread(this.requestedPauses.length - 1);
		}
	}

	private pauseThread(pauseRequestIndex: number) {

		let pauseRequest = this.requestedPauses[pauseRequestIndex];
		log.debug(`Interrupting ${pauseRequest.threadName}`);

		this.requestedPauses.splice(pauseRequestIndex, 1);

		if (this.findPauseIndex(pauseRequest.threadId) === undefined) {

			this.interruptingThread =  {
				threadId: pauseRequest.threadId,
				threadName: pauseRequest.threadName,
				pauseType: pauseRequest.pauseType
			};

		} else {
			log.warn(`Executing pause request for ${pauseRequest.threadName} but it seems to be paused already`);
		}

		pauseRequest.pendingRequest.resolve(undefined);
	}

	private resumeThread(resumeRequestIndex: number) {

		let resumeRequest = this.requestedResumes[resumeRequestIndex];
		log.debug(`Resuming ${resumeRequest.threadName}`);

		this.requestedResumes.splice(resumeRequestIndex, 1);

		this.resumingThread = {
			threadId: resumeRequest.threadId,
			threadName: resumeRequest.threadName
		};

		resumeRequest.pendingRequest.resolve(undefined);
	}

	private findPauseIndex(threadId: number): number | undefined {

		for (let i = this.currentPauses.length - 1; i >= 0; i--) {
			if (this.currentPauses[i].threadId === threadId) {
				return i;
			}
		}

		return undefined;
	}

	private findResumeRequestIndex(threadId: number): number | undefined {

		for (let i = 0; i < this.requestedResumes.length; i++) {
			if (this.requestedResumes[i].threadId === threadId) {
				return i;
			}
		}

		return undefined;
	}

	private findAutomaticPauseRequestIndex(): number | undefined {

		for (let i = 0; i < this.requestedPauses.length; i++) {
			if (this.requestedPauses[i].pauseType === 'auto') {
				return i;
			}
		}

		return undefined;
	}

	private findHinderingPauses(resumeThreadId: number): ThreadPauseInfo[] {

		let hinderingPauses: ThreadPauseInfo[] = [];

		if ((this.interruptingThread !== undefined) && 
			(this.interruptingThread.threadId !== resumeThreadId) &&
			(this.interruptingThread.pauseType === 'user')) {

			hinderingPauses.push(this.interruptingThread);
		}

		for (let i = this.currentPauses.length - 1; i >= 0; i--) {

			let pause = this.currentPauses[i];

			if (pause.threadId === resumeThreadId) {
				break;
			}

			if (pause.pauseType === 'user') {
				hinderingPauses.push(pause);
			}
		}

		return hinderingPauses;
	}
}

interface ThreadInfo {
	threadId: number;
	threadName: string;
}

interface ThreadPauseInfo extends ThreadInfo {
	pauseType: PauseType;
}

interface PendingThreadPauseRequest extends ThreadPauseInfo {
	pendingRequest: PendingRequest<void>;
}

interface PendingThreadResumeRequest extends ThreadInfo {
	pendingRequest: PendingRequest<void>;
}
