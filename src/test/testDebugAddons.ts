import { DebugClient } from 'vscode-debugadapter-testsupport';
import * as path from 'path';
import * as util from './util';
import * as assert from 'assert';

describe('Firefox debug adapter', function() {

	let dc: DebugClient;
	const TESTDATA_PATH = path.join(__dirname, '../../testdata');

	beforeEach(async function() {
		dc = await util.initDebugClientForAddon(TESTDATA_PATH, 'webExtension', true);
	});

	afterEach(async function() {
		await dc.stop();
	});

	it('should debug a WebExtension', async function() {

		let backgroundScriptPath = path.join(TESTDATA_PATH, 'webExtension/addOn/backgroundscript.js');
		await util.setBreakpoints(dc, backgroundScriptPath, [ 2 ]);

		let contentScriptPath = path.join(TESTDATA_PATH, 'webExtension/addOn/contentscript.js');
		await util.setBreakpoints(dc, contentScriptPath,  [ 2 ]);

		let stoppedEvent = await util.receiveStoppedEvent(dc);
		let contentThreadId = stoppedEvent.body.threadId!;
		let stackTrace = await dc.stackTraceRequest({ threadId: contentThreadId });

		assert.equal(stackTrace.body.stackFrames[0].source!.path, contentScriptPath);

		dc.continueRequest({ threadId: contentThreadId });
		stoppedEvent = await util.receiveStoppedEvent(dc);
		let addOnThreadId = stoppedEvent.body.threadId!;
		stackTrace = await dc.stackTraceRequest({ threadId: addOnThreadId });

		assert.notEqual(contentThreadId, addOnThreadId);
	});
});
