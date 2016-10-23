import { DebugClient } from 'vscode-debugadapter-testsupport';
import * as path from 'path';
import * as util from './util';
import * as assert from 'assert';

describe('Firefox debug adapter', function() {

	let dc: DebugClient;
	const TESTDATA_PATH = path.join(__dirname, '../../testdata');

	beforeEach(async function() {
		dc = await util.initDebugClient(TESTDATA_PATH, false);
	});

	afterEach(async function() {
		await dc.stop();
	});

	it('should immediately verify a breakpoint set on a loaded file', async function() {

		await util.receivePageLoadedEvent(dc);

		let sourcePath = path.join(TESTDATA_PATH, 'web/test.js');
		let setBreakpointsResponse = await util.setBreakpoints(dc, sourcePath, [ 3 ]);

		assert.equal(setBreakpointsResponse.body.breakpoints.length, 1);
		assert.equal(setBreakpointsResponse.body.breakpoints[0].verified, true);
		assert.equal(setBreakpointsResponse.body.breakpoints[0].line, 3);
	});

	it('should immediately move and verify a breakpoint set on a loaded file', async function() {

		await util.receivePageLoadedEvent(dc);

		let sourcePath = path.join(TESTDATA_PATH, 'web/test.js');
		let setBreakpointsResponse = await util.setBreakpoints(dc, sourcePath, [ 2 ]);

		assert.equal(setBreakpointsResponse.body.breakpoints.length, 1);
		assert.equal(setBreakpointsResponse.body.breakpoints[0].verified, true);
		assert.equal(setBreakpointsResponse.body.breakpoints[0].line, 3);
	});

	it('should eventually verify a breakpoint set before the page is loaded', async function() {

		let sourcePath = path.join(TESTDATA_PATH, 'web/test.js');
		let setBreakpointsResponse = await util.setBreakpoints(dc, sourcePath, [ 3 ]);

		assert.equal(setBreakpointsResponse.body.breakpoints.length, 1);
		assert.equal(setBreakpointsResponse.body.breakpoints[0].verified, false);
		let breakpointId = setBreakpointsResponse.body.breakpoints[0].id;

		await util.receiveBreakpointEvent(dc).then((ev) => {
			assert.equal(ev.body.reason, 'update');
			assert.equal(ev.body.breakpoint.id, breakpointId);
			assert.equal(ev.body.breakpoint.verified, true);
			assert.equal(ev.body.breakpoint.line, 3);
		});
	});

	it('should eventually move and verify a breakpoint set before the page is loaded', async function() {

		let sourcePath = path.join(TESTDATA_PATH, 'web/test.js');
		let setBreakpointsResponse = await util.setBreakpoints(dc, sourcePath, [ 2 ]);

		assert.equal(setBreakpointsResponse.body.breakpoints.length, 1);
		assert.equal(setBreakpointsResponse.body.breakpoints[0].verified, false);
		let breakpointId = setBreakpointsResponse.body.breakpoints[0].id;

		await util.receiveBreakpointEvent(dc).then((ev) => {
			assert.equal(ev.body.reason, 'update');
			assert.equal(ev.body.breakpoint.id, breakpointId);
			assert.equal(ev.body.breakpoint.verified, true);
			assert.equal(ev.body.breakpoint.line, 3);
		});
	});

	it('should eventually verify a breakpoint set on a dynamically loaded script', async function() {

		await util.receivePageLoadedEvent(dc);

		let sourcePath = path.join(TESTDATA_PATH, 'web/script.js');
		let setBreakpointsResponse = await util.setBreakpoints(dc, sourcePath, [ 3 ]);

		assert.equal(setBreakpointsResponse.body.breakpoints.length, 1);
		assert.equal(setBreakpointsResponse.body.breakpoints[0].verified, false);
		let breakpointId = setBreakpointsResponse.body.breakpoints[0].id;

		util.evaluate(dc, 'loadScript("script.js")');

		await util.receiveBreakpointEvent(dc).then((ev) => {
			assert.equal(ev.body.reason, 'update');
			assert.equal(ev.body.breakpoint.id, breakpointId);
			assert.equal(ev.body.breakpoint.verified, true);
			assert.equal(ev.body.breakpoint.line, 3);
		});
	});
});
