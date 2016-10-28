import { DebugClient } from 'vscode-debugadapter-testsupport';
import { DebugProtocol } from 'vscode-debugprotocol';
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

	it('should forward messages from the browser console to vscode', async function() {

		util.evaluate(dc, 'console.log("log")');
		let outputEvent = <DebugProtocol.OutputEvent> await dc.waitForEvent('output');

		assert.equal(outputEvent.body.category, 'stdout');
		assert.equal(outputEvent.body.output.trim(), 'log');

		util.evaluate(dc, 'console.debug("debug")');
		outputEvent = <DebugProtocol.OutputEvent> await dc.waitForEvent('output');

		assert.equal(outputEvent.body.category, 'stdout');
		assert.equal(outputEvent.body.output.trim(), 'debug');

		util.evaluate(dc, 'console.info("info")');
		outputEvent = <DebugProtocol.OutputEvent> await dc.waitForEvent('output');

		assert.equal(outputEvent.body.category, 'stdout');
		assert.equal(outputEvent.body.output.trim(), 'info');

		util.evaluate(dc, 'console.warn("warn")');
		outputEvent = <DebugProtocol.OutputEvent> await dc.waitForEvent('output');

		assert.equal(outputEvent.body.category, 'console');
		assert.equal(outputEvent.body.output.trim(), 'warn');

		util.evaluate(dc, 'console.error("error")');
		outputEvent = <DebugProtocol.OutputEvent> await dc.waitForEvent('output');

		assert.equal(outputEvent.body.category, 'stderr');
		assert.equal(outputEvent.body.output.trim(), 'error');
	});

	it('should send error messages from the browser to vscode', async function() {

		dc.setExceptionBreakpointsRequest({ filters: [] });

		util.evaluateDelayed(dc, 'foo.bar', 0);
		let outputEvent = <DebugProtocol.OutputEvent> await dc.waitForEvent('output');

		assert.equal(outputEvent.body.category, 'stderr');
		assert.equal(outputEvent.body.output.trim(), 'ReferenceError: foo is not defined');

		util.evaluateDelayed(dc, 'eval("foo(")', 0);
		outputEvent = <DebugProtocol.OutputEvent> await dc.waitForEvent('output');

		assert.equal(outputEvent.body.category, 'stderr');
		assert.equal(outputEvent.body.output.trim(), 'SyntaxError: expected expression, got end of script');

		util.evaluateDelayed(dc, 'throw new Error("Something went wrong")', 0);
		outputEvent = <DebugProtocol.OutputEvent> await dc.waitForEvent('output');

		assert.equal(outputEvent.body.category, 'stderr');
		assert.equal(outputEvent.body.output.trim(), 'Error: Something went wrong');
	});
});
