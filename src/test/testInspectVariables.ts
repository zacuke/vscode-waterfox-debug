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

	it('should inspect variables of different types in different scopes', async function() {

		let sourcePath = path.join(TESTDATA_PATH, 'web/test.js');
		await util.setBreakpoints(dc, sourcePath, [ 17 ]);

		util.evaluate(dc, 'vars({ key: "value" })');
		let stoppedEvent = await util.receiveStoppedEvent(dc);
		let stackTrace = await dc.stackTraceRequest({ threadId: stoppedEvent.body.threadId! });
		let scopes = await dc.scopesRequest({ frameId: stackTrace.body.stackFrames[0].id });

		let variablesResponse = await dc.variablesRequest({ variablesReference: scopes.body.scopes[0].variablesReference });
		let variables = variablesResponse.body.variables;
		assert.equal(util.findVariable(variables, 'str2').value, '"foo"');
		assert.equal(util.findVariable(variables, 'undef').value, 'undefined');
		assert.equal(util.findVariable(variables, 'nul').value, 'null');

		variablesResponse = await dc.variablesRequest({ variablesReference: scopes.body.scopes[1].variablesReference });
		variables = variablesResponse.body.variables;
		assert.equal(util.findVariable(variables, 'bool1').value, 'false');
		assert.equal(util.findVariable(variables, 'bool2').value, 'true');
		assert.equal(util.findVariable(variables, 'num1').value, '0');
		assert.equal(util.findVariable(variables, 'num2').value, '17');
		assert.equal(util.findVariable(variables, 'str1').value, '""');

		variablesResponse = await dc.variablesRequest({ variablesReference: scopes.body.scopes[2].variablesReference });
		let variable = util.findVariable(variablesResponse.body.variables, 'arg')!;
		assert.equal(variable.value, 'Object');
		variablesResponse = await dc.variablesRequest({ variablesReference: variable.variablesReference });
		assert.equal(util.findVariable(variablesResponse.body.variables, 'key').value, '"value"');
	});

	it('should inspect variables in different stackframes', async function() {

		let sourcePath = path.join(TESTDATA_PATH, 'web/test.js');
		await util.setBreakpoints(dc, sourcePath, [ 23 ]);

		util.evaluate(dc, 'factorial(4)');
		let stoppedEvent = await util.receiveStoppedEvent(dc);
		let stackTrace = await dc.stackTraceRequest({ threadId: stoppedEvent.body.threadId! });

		for (let i = 0; i < 4; i++) {
			let scopes = await dc.scopesRequest({ frameId: stackTrace.body.stackFrames[i].id });
			let variables = await dc.variablesRequest({ variablesReference: scopes.body.scopes[0].variablesReference });
			assert.equal(util.findVariable(variables.body.variables, 'n').value, i + 1);
		}
	});

	it('should inspect return values on stepping out', async function() {

		let sourcePath = path.join(TESTDATA_PATH, 'web/test.js');
		await util.setBreakpoints(dc, sourcePath, [ 23 ]);

		util.evaluate(dc, 'factorial(4)');
		let stoppedEvent = await util.receiveStoppedEvent(dc);
		let threadId = stoppedEvent.body.threadId!;

		for (let i = 0; i < 4; i++) {
			await dc.stepOutRequest({ threadId });
			await util.receiveStoppedEvent(dc);
			let stackTrace = await dc.stackTraceRequest({ threadId: stoppedEvent.body.threadId! });
			let scopes = await dc.scopesRequest({ frameId: stackTrace.body.stackFrames[0].id });
			let variables = await dc.variablesRequest({ variablesReference: scopes.body.scopes[0].variablesReference });
			assert.equal(util.findVariable(variables.body.variables, '<return>').value, factorial(i + 1));
		}
	})
});

function factorial(n: number): number {
	if (n <= 1) {
		return 1;
	} else {
		return n * factorial(n - 1);
	}
}
