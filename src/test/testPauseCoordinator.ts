import { ThreadPauseCoordinator, PauseType } from '../adapter/threadPauseCoordinator';
import { delay } from '../util/misc';
import * as assert from 'assert';

describe('ThreadPauseCoordinator', function() {

	let pauseCoordinator: ThreadPauseCoordinator;

	beforeEach(function() {
		pauseCoordinator = new ThreadPauseCoordinator();
	});

	it('should pause and resume a single thread', async function() {

		let events: string[] = [];

		events.push('Request pausing #1');
		pauseCoordinator.requestPause(1, 'Thread 1', 'user').then(async () => {
			events.push('Pausing #1');
			await delay(10);
			events.push('Paused #1');
			pauseCoordinator.notifyPaused(1, 'Thread 1', 'user');
		});

		events.push('Request resuming #1');
		await pauseCoordinator.requestResume(1, 'Thread 1').then(async () => {
			events.push('Resuming #1');
			await delay(10);
			events.push('Resumed #1');
			pauseCoordinator.notifyResumed(1, 'Thread 1');
		});

		assert.deepEqual(events, [
			'Request pausing #1',
			'Request resuming #1',
			'Pausing #1',
			'Paused #1',
			'Resuming #1',
			'Resumed #1'
		]);
	});

	it('should allow the user to pause 2 threads', async function() {

		let events: string[] = [];

		events.push('Request pausing #1');
		pauseCoordinator.requestPause(1, 'Thread 1', 'user').then(async () => {
			events.push('Pausing #1');
			await delay(10);
			events.push('Paused #1');
			pauseCoordinator.notifyPaused(1, 'Thread 1', 'user');
		});

		events.push('Request pausing #2');
		await pauseCoordinator.requestPause(2, 'Thread 2', 'user').then(async () => {
			events.push('Pausing #2');
		});

		assert.deepEqual(events, [
			'Request pausing #1',
			'Request pausing #2',
			'Pausing #1',
			'Paused #1',
			'Pausing #2'
		]);
	});

	it('should wait for an automatically paused thread to be resumed before allowing another thread to be paused by the user', async function() {

		let events: string[] = [];

		events.push('Request pausing #1');
		let autoPausePromise = pauseCoordinator.requestPause(1, 'Thread 1', 'auto').then(async () => {
			events.push('Pausing #1');
			await delay(10);
			events.push('Paused #1');
			pauseCoordinator.notifyPaused(1, 'Thread 1', 'auto');
		});

		events.push('Request pausing #2');
		let userPausePromise = pauseCoordinator.requestPause(2, 'Thread 2', 'user').then(async () => {
			events.push('Pausing #2');
		});

		await autoPausePromise;
		events.push('Request resuming #1');
		pauseCoordinator.requestResume(1, 'Thread 1').then(async () => {
			events.push('Resuming #1');
			await delay(10);
			events.push('Resumed #1');
			pauseCoordinator.notifyResumed(1, 'Thread 1');
		});

		await userPausePromise;

		assert.deepEqual(events, [
			'Request pausing #1',
			'Request pausing #2',
			'Pausing #1',
			'Paused #1',
			'Request resuming #1',
			'Resuming #1',
			'Resumed #1',
			'Pausing #2'
		]);
	});

	it('should wait for an automatically paused thread to be resumed before allowing a thread paused earlier to be resumed', async function() {

		let events: string[] = [];

		events.push('Request pausing #1');
		pauseCoordinator.requestPause(1, 'Thread 1', 'auto').then(async () => {
			events.push('Pausing #1');
			await delay(10);
			events.push('Paused #1');
			pauseCoordinator.notifyPaused(1, 'Thread 1', 'auto');
		});

		events.push('Request pausing #2');
		await pauseCoordinator.requestPause(2, 'Thread 2', 'auto').then(async () => {
			events.push('Pausing #2');
			await delay(10);
			events.push('Paused #2');
			pauseCoordinator.notifyPaused(2, 'Thread 2', 'auto');
		});

		events.push('Request resuming #1');
		let resumePromise = pauseCoordinator.requestResume(1, 'Thread 1').then(async () => {
			events.push('Resuming #1');
			await delay(10);
			events.push('Resumed #1');
			pauseCoordinator.notifyResumed(1, 'Thread 1');
		});

		events.push('Request resuming #2');
		pauseCoordinator.requestResume(2, 'Thread 2').then(async () => {
			events.push('Resuming #2');
			await delay(10);
			events.push('Resumed #2');
			pauseCoordinator.notifyResumed(2, 'Thread 2');
		});

		await resumePromise;

		assert.deepEqual(events, [
			'Request pausing #1',
			'Request pausing #2',
			'Pausing #1',
			'Paused #1',
			'Pausing #2',
			'Paused #2',
			'Request resuming #1',
			'Request resuming #2',
			'Resuming #2',
			'Resumed #2',
			'Resuming #1',
			'Resumed #1',
		]);
	});

	it('should reject resuming threads in the wrong order', async function() {

		pauseCoordinator.requestPause(1, 'Thread 1', 'user').then(async () => {
			pauseCoordinator.notifyPaused(1, 'Thread 1', 'user');
		});

		await pauseCoordinator.requestPause(2, 'Thread 2', 'user').then(async () => {
			pauseCoordinator.notifyPaused(2, 'Thread 2', 'user');
		});

		let resumeRequestFailed = false;
		try {
			await pauseCoordinator.requestResume(1, 'Thread 1');
		} catch (err) {
			resumeRequestFailed = true;
			assert.equal(err, 'Thread 1 can\'t be resumed because you need to resume Thread 2 first');
		}
		assert.equal(resumeRequestFailed, true);
	});
});
