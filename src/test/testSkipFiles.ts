import { DebugClient } from 'vscode-debugadapter-testsupport';
import * as path from 'path';
import * as util from './util';
import * as assert from 'assert';
import { delay } from '../util/misc';

describe('Firefox debug adapter', function() {

	let dc: DebugClient;
	const TESTDATA_PATH = path.join(__dirname, '../../testdata');

	beforeEach(async function() {
		dc = await util.initDebugClient(TESTDATA_PATH, true, {
			skipFiles: [ '**/dlscript.js' ]
		});
	});

	afterEach(async function() {
		await dc.stop();
	});

	it.only('should skip exceptions in blackboxed files', async function() {

		await dc.setExceptionBreakpointsRequest({filters: [ 'all' ]});

		await util.evaluate(dc, 'loadScript("dlscript.js")');

		let stoppedEvent = await util.runCommandAndReceiveStoppedEvent(dc,
			() => util.evaluate(dc, 'try{ testSkipFiles() }catch(e){}'));
		let stacktrace = await dc.stackTraceRequest({ threadId: stoppedEvent.body.threadId });

		assert.equal(stacktrace.body.stackFrames[0].source!.path, path.join(TESTDATA_PATH, 'web/main.js'));
		assert.equal(stacktrace.body.stackFrames[0].line, 76);
	});

	it.only('should skip breakpoints in blackboxed files', async function() {

		await dc.setExceptionBreakpointsRequest({filters: []});
		await util.setBreakpoints(dc, path.join(TESTDATA_PATH, 'web/dlscript.js'), [ 3 ]);
		await util.setBreakpoints(dc, path.join(TESTDATA_PATH, 'web/main.js'), [ 76 ]);

		await util.evaluate(dc, 'loadScript("dlscript.js")');
		await delay(1000);

		let stoppedEvent = await util.runCommandAndReceiveStoppedEvent(dc,
			() => util.evaluate(dc, 'try{ testSkipFiles() }catch(e){}'));
		let stacktrace = await dc.stackTraceRequest({ threadId: stoppedEvent.body.threadId });

		assert.equal(stacktrace.body.stackFrames[0].source!.path, path.join(TESTDATA_PATH, 'web/main.js'));
		assert.equal(stacktrace.body.stackFrames[0].line, 76);
	});
});
