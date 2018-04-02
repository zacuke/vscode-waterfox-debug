import { DebugClient } from 'vscode-debugadapter-testsupport';
import { DebugProtocol } from 'vscode-debugprotocol';
import * as path from 'path';
import * as util from './util';
import * as assert from 'assert';

describe.only('Firefox debug adapter', function() {

	let dc: DebugClient;
	const TESTDATA_PATH = path.join(__dirname, '../../testdata');
	const SOURCE_PATH = path.join(TESTDATA_PATH, 'web/main.js');

	beforeEach(async function() {
		dc = await util.initDebugClient(TESTDATA_PATH, true);
	});

	afterEach(async function() {
		await dc.stop();
	});

	it('should show accessor properties', async function() {

		let properties = await startAndGetProperties(dc, SOURCE_PATH);

		assert.equal(util.findVariable(properties, 'getterProperty').value, 'Getter - expand to execute Getter');
		assert.equal(util.findVariable(properties, 'setterProperty').value, 'Setter');
		assert.equal(util.findVariable(properties, 'getterAndSetterProperty').value, 'Getter & Setter - expand to execute Getter');
	});

	it('should execute getters on demand', async function() {

		let properties = await startAndGetProperties(dc, SOURCE_PATH);

		let getterProperty = util.findVariable(properties, 'getterProperty');
		let getterPropertyResponse = await dc.variablesRequest({ variablesReference: getterProperty.variablesReference });
		let getterValue = util.findVariable(getterPropertyResponse.body.variables, 'Value from Getter').value;
		assert.equal(getterValue, '17');

		let getterAndSetterProperty = util.findVariable(properties, 'getterAndSetterProperty');
		let getterAndSetterPropertyResponse = await dc.variablesRequest({ variablesReference: getterAndSetterProperty.variablesReference });
		let getterAndSetterValue = util.findVariable(getterAndSetterPropertyResponse.body.variables, 'Value from Getter').value;
		assert.equal(getterAndSetterValue, '23');
	});

	it('should execute nested getters', async function() {

		let properties1 = await startAndGetProperties(dc, SOURCE_PATH);

		let getterProperty1 = util.findVariable(properties1, 'nested');
		let getterPropertyResponse1 = await dc.variablesRequest({ variablesReference: getterProperty1.variablesReference });
		let getterValue1 = util.findVariable(getterPropertyResponse1.body.variables, 'Value from Getter');

		let propertiesResponse2 = await dc.variablesRequest({ variablesReference: getterValue1.variablesReference });
		let properties2 = propertiesResponse2.body.variables;

		let getterProperty2 = util.findVariable(properties2, 'z');
		let getterPropertyResponse2 = await dc.variablesRequest({ variablesReference: getterProperty2.variablesReference });
		let getterValue2 = util.findVariable(getterPropertyResponse2.body.variables, 'Value from Getter').value;

		assert.equal(getterValue2, '"foo"');
	});
});

async function startAndGetProperties(dc: DebugClient, sourcePath: string): Promise<DebugProtocol.Variable[]> {

	await util.setBreakpoints(dc, sourcePath, [ 94 ]);

	util.evaluate(dc, 'getterAndSetter()');
	let stoppedEvent = await util.receiveStoppedEvent(dc);
	let stackTrace = await dc.stackTraceRequest({ threadId: stoppedEvent.body.threadId! });
	let scopes = await dc.scopesRequest({ frameId: stackTrace.body.stackFrames[0].id });

	let variablesResponse = await dc.variablesRequest({ variablesReference: scopes.body.scopes[0].variablesReference });
	let variable = util.findVariable(variablesResponse.body.variables, 'x');
	let propertiesResponse = await dc.variablesRequest({ variablesReference: variable.variablesReference });
	return propertiesResponse.body.variables;
}
