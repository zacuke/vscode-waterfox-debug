import { DebugClient } from 'vscode-debugadapter-testsupport';
import * as path from 'path';
import * as util from './util';
import * as assert from 'assert';

describe('Firefox debug adapter', function() {

	let dc: DebugClient;
	const TESTDATA_PATH = path.join(__dirname, '../../testdata');

	beforeEach(async function() {
		dc = await util.initDebugClient(TESTDATA_PATH, true);
	});

	afterEach(async function() {
		await dc.stop();
	});

	it('should hit a breakpoint', async function() {

		let sourcePath = path.join(TESTDATA_PATH, 'web/main.js');
		await util.setBreakpoints(dc, sourcePath, [ 3 ]);

		util.evaluateDelayed(dc, 'noop()', 0);

		let stoppedEvent = await util.receiveStoppedEvent(dc);
		assert.equal(stoppedEvent.body.allThreadsStopped, false);
		assert.equal(stoppedEvent.body.reason, 'breakpoint');
	});

	it('should hit a breakpoint in an evaluateRequest', async function() {

		let sourcePath = path.join(TESTDATA_PATH, 'web/main.js');
		await util.setBreakpoints(dc, sourcePath, [ 3 ]);

		util.evaluate(dc, 'noop()');

		let stoppedEvent = await util.receiveStoppedEvent(dc);
		assert.equal(stoppedEvent.body.allThreadsStopped, false);
		assert.equal(stoppedEvent.body.reason, 'breakpoint');
	});

	it('should hit an uncaught exception breakpoint', async function() {

		await dc.setExceptionBreakpointsRequest({filters: [ 'uncaught' ]});

		util.evaluateDelayed(dc, 'throwException()', 0);

		let stoppedEvent = await util.receiveStoppedEvent(dc);
		assert.equal(stoppedEvent.body.allThreadsStopped, false);
		assert.equal(stoppedEvent.body.reason, 'exception');
	});

	it('should not hit an uncaught exception breakpoint', async function() {

		await dc.setExceptionBreakpointsRequest({filters: []});

		util.evaluateDelayed(dc, 'throwException()', 0);

		await util.assertPromiseTimeout(util.receiveStoppedEvent(dc), 1000);
	});

	it('should hit a caught exception breakpoint', async function() {

		await dc.setExceptionBreakpointsRequest({filters: [ 'all' ]});

		util.evaluateDelayed(dc, 'throwAndCatchException()', 0);

		let stoppedEvent = await util.receiveStoppedEvent(dc);
		assert.equal(stoppedEvent.body.allThreadsStopped, false);
		assert.equal(stoppedEvent.body.reason, 'exception');
	});

	it('should not hit a caught exception breakpoint', async function() {

		await dc.setExceptionBreakpointsRequest({filters: [ 'uncaught' ]});

		util.evaluateDelayed(dc, 'throwAndCatchException()', 0);

		await util.assertPromiseTimeout(util.receiveStoppedEvent(dc), 1000);
	});
});
