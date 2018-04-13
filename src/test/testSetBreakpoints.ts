import { DebugClient } from 'vscode-debugadapter-testsupport';
import * as path from 'path';
import * as util from './util';
import * as assert from 'assert';
import { delay } from '../util/misc';

describe('Firefox debug adapter', function() {

	let dc: DebugClient;
	const TESTDATA_PATH = path.join(__dirname, '../../testdata');

	beforeEach(async function() {
		dc = await util.initDebugClient(TESTDATA_PATH, false);
	});

	afterEach(async function() {
		await dc.stop();
	});

	it('should eventually verify a breakpoint set on a loaded file', async function() {

		await util.receivePageLoadedEvent(dc);

		let sourcePath = path.join(TESTDATA_PATH, 'web/main.js');
		let setBreakpointsResponse = await util.setBreakpoints(dc, sourcePath, [ 3 ], false);
		let breakpointId = setBreakpointsResponse.body.breakpoints[0].id;

		assert.equal(setBreakpointsResponse.body.breakpoints.length, 1);
		assert.equal(setBreakpointsResponse.body.breakpoints[0].verified, false);
		assert.equal(setBreakpointsResponse.body.breakpoints[0].line, 3);

		let ev = await util.receiveBreakpointEvent(dc);
		assert.equal(ev.body.reason, 'changed');
		assert.equal(ev.body.breakpoint.id, breakpointId);
		assert.equal(ev.body.breakpoint.verified, true);
		assert.equal(ev.body.breakpoint.line, 3);
	});

	it('should eventually move and verify a breakpoint set on a loaded file', async function() {

		await util.receivePageLoadedEvent(dc);

		let sourcePath = path.join(TESTDATA_PATH, 'web/main.js');
		let setBreakpointsResponse = await util.setBreakpoints(dc, sourcePath, [ 2 ], false);
		let breakpointId = setBreakpointsResponse.body.breakpoints[0].id;

		assert.equal(setBreakpointsResponse.body.breakpoints.length, 1);
		assert.equal(setBreakpointsResponse.body.breakpoints[0].verified, false);
		assert.equal(setBreakpointsResponse.body.breakpoints[0].line, 2);

		let ev = await util.receiveBreakpointEvent(dc);
		assert.equal(ev.body.reason, 'changed');
		assert.equal(ev.body.breakpoint.id, breakpointId);
		assert.equal(ev.body.breakpoint.verified, true);
		assert.equal(ev.body.breakpoint.line, 3);
	});

	it('should eventually verify a breakpoint set before the page is loaded', async function() {

		let sourcePath = path.join(TESTDATA_PATH, 'web/main.js');
		let setBreakpointsResponse = await util.setBreakpoints(dc, sourcePath, [ 3 ], false);

		assert.equal(setBreakpointsResponse.body.breakpoints.length, 1);
		assert.equal(setBreakpointsResponse.body.breakpoints[0].verified, false);
		let breakpointId = setBreakpointsResponse.body.breakpoints[0].id;

		let ev = await util.receiveBreakpointEvent(dc);
		assert.equal(ev.body.reason, 'changed');
		assert.equal(ev.body.breakpoint.id, breakpointId);
		assert.equal(ev.body.breakpoint.verified, true);
		assert.equal(ev.body.breakpoint.line, 3);
	});

	it('should eventually move and verify a breakpoint set before the page is loaded', async function() {

		let sourcePath = path.join(TESTDATA_PATH, 'web/main.js');
		let setBreakpointsResponse = await util.setBreakpoints(dc, sourcePath, [ 2 ], false);

		assert.equal(setBreakpointsResponse.body.breakpoints.length, 1);
		assert.equal(setBreakpointsResponse.body.breakpoints[0].verified, false);
		let breakpointId = setBreakpointsResponse.body.breakpoints[0].id;

		let ev = await util.receiveBreakpointEvent(dc);
		assert.equal(ev.body.reason, 'changed');
		assert.equal(ev.body.breakpoint.id, breakpointId);
		assert.equal(ev.body.breakpoint.verified, true);
		assert.equal(ev.body.breakpoint.line, 3);
	});

	it('should eventually verify a breakpoint set on a dynamically loaded script', async function() {

		await util.receivePageLoadedEvent(dc);

		let sourcePath = path.join(TESTDATA_PATH, 'web/dlscript.js');
		let setBreakpointsResponse = await util.setBreakpoints(dc, sourcePath, [ 3 ], false);

		assert.equal(setBreakpointsResponse.body.breakpoints.length, 1);
		assert.equal(setBreakpointsResponse.body.breakpoints[0].verified, false);
		let breakpointId = setBreakpointsResponse.body.breakpoints[0].id;

		util.evaluate(dc, 'loadScript("dlscript.js")');

		let ev = await util.receiveBreakpointEvent(dc);
		assert.equal(ev.body.reason, 'changed');
		assert.equal(ev.body.breakpoint.id, breakpointId);
		assert.equal(ev.body.breakpoint.verified, true);
		assert.equal(ev.body.breakpoint.line, 3);
	});

	it('should keep old breakpoints verified when setting new ones', async function() {

		await util.receivePageLoadedEvent(dc);

		let sourcePath = path.join(TESTDATA_PATH, 'web/main.js');
		await util.setBreakpoints(dc, sourcePath, [ 3 ]);
		let setBreakpointsResponse = await util.setBreakpoints(dc, sourcePath, [ 3, 8 ], false);

		assert.equal(setBreakpointsResponse.body.breakpoints.length, 2);
		assert.equal(setBreakpointsResponse.body.breakpoints[0].line, 3);
		assert.equal(setBreakpointsResponse.body.breakpoints[0].verified, true);
		assert.equal(setBreakpointsResponse.body.breakpoints[1].line, 8);
		assert.equal(setBreakpointsResponse.body.breakpoints[1].verified, false);
	});

	it('should handle multiple setBreakpointsRequests in quick succession', async function() {

		await util.receivePageLoadedEvent(dc);

		let sourcePath = path.join(TESTDATA_PATH, 'web/main.js');
		util.setBreakpoints(dc, sourcePath, [ 11 ], false);
		util.setBreakpoints(dc, sourcePath, [ 10, 8 ], false);
		let setBreakpointsResponse = await util.setBreakpoints(dc, sourcePath, [ 9, 10 ], false);

		assert.equal(setBreakpointsResponse.body.breakpoints.length, 2);
		assert.equal(setBreakpointsResponse.body.breakpoints[0].verified, false);
		assert.equal(setBreakpointsResponse.body.breakpoints[1].verified, false);

		await delay(100);

		let stoppedEvent = await util.runCommandAndReceiveStoppedEvent(dc, 
			() => util.evaluate(dc, 'vars()')
		);

		let stackTrace = await dc.stackTraceRequest({ threadId: stoppedEvent.body.threadId! });

		assert.equal(stackTrace.body.stackFrames[0].line, 9);
	});

	it('should remove a breakpoint', async function() {

		await util.receivePageLoadedEvent(dc);

		let sourcePath = path.join(TESTDATA_PATH, 'web/main.js');
		let setBreakpointsResponse = await util.setBreakpoints(dc, sourcePath, [ 3 ], false);

		assert.equal(setBreakpointsResponse.body.breakpoints.length, 1);
		assert.equal(setBreakpointsResponse.body.breakpoints[0].verified, false);

		setBreakpointsResponse = await util.setBreakpoints(dc, sourcePath, [], false);

		assert.equal(setBreakpointsResponse.body.breakpoints.length, 0);
	});

	it('should change the condition on an already set breakpoint', async function() {

		await util.receivePageLoadedEvent(dc);

		let sourcePath = path.join(TESTDATA_PATH, 'web/main.js');
		await util.setBreakpoints(dc, sourcePath, [ { line: 24 } ]);

		let stoppedEvent = await util.runCommandAndReceiveStoppedEvent(dc, 
			() => util.evaluate(dc, 'factorial(5)')
		);

		let threadId = stoppedEvent.body.threadId!;
		let stackTrace = await dc.stackTraceRequest({ threadId });
		let scopes = await dc.scopesRequest({ frameId: stackTrace.body.stackFrames[0].id });

		let variablesResponse = await dc.variablesRequest({ variablesReference: scopes.body.scopes[0].variablesReference });
		let variables = variablesResponse.body.variables;
		assert.equal(util.findVariable(variables, 'n').value, '5');

		await util.setBreakpoints(dc, sourcePath, [ { line: 24, condition: 'n === 2' } ]);
		await dc.continueRequest({ threadId });

		await util.runCommandAndReceiveStoppedEvent(dc, 
			() => util.evaluate(dc, 'factorial(5)')
		);

		stackTrace = await dc.stackTraceRequest({ threadId });
		scopes = await dc.scopesRequest({ frameId: stackTrace.body.stackFrames[0].id });

		variablesResponse = await dc.variablesRequest({ variablesReference: scopes.body.scopes[0].variablesReference });
		variables = variablesResponse.body.variables;
		assert.equal(util.findVariable(variables, 'n').value, '2');
	});
});
