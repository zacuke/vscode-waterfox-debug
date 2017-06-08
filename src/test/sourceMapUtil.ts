import * as path from 'path';
import * as fs from 'fs-extra';
import { Stream } from 'stream';
import * as assert from 'assert';
import { DebugClient } from "vscode-debugadapter-testsupport";
import * as util from './util';

export async function testSourcemaps(
	dc: DebugClient,
	srcDir: string,
	launchArgs: any,
	stepInRepeat = 1
): Promise<void> {

	await dc.start();
	await Promise.all([
		dc.launch(launchArgs),
		dc.configurationSequence()
	]);

	await util.receivePageLoadedEvent(dc);

	let fPath = path.join(srcDir, 'f.js');
	let gPath = path.join(srcDir, 'g.js');

	util.setBreakpoints(dc, fPath, [ 7 ]);

	util.evaluateDelayed(dc, 'f()', 0);
	let stoppedEvent = await util.receiveStoppedEvent(dc);
	let threadId = stoppedEvent.body.threadId!;

	await checkDebuggeeState(dc, threadId, fPath, 7, 'x', '2');

	for (let i = 0; i < stepInRepeat; i++) {
		dc.stepInRequest({ threadId });
		await util.receiveStoppedEvent(dc);
	}

	await checkDebuggeeState(dc, threadId, gPath, 5, 'y', '2');

	dc.stepOutRequest({ threadId });
	await util.receiveStoppedEvent(dc);
	dc.stepOutRequest({ threadId });
	await util.receiveStoppedEvent(dc);

	await checkDebuggeeState(dc, threadId, fPath, 8, 'x', '4');

	util.setBreakpoints(dc, gPath, [ 5 ]);

	dc.continueRequest({ threadId });
	await util.receiveStoppedEvent(dc);

	await checkDebuggeeState(dc, threadId, gPath, 5, 'y', '4');

	await dc.stop();
}

async function checkDebuggeeState(
	dc: DebugClient,
	threadId: number,
	sourcePath: string,
	line: number,
	variable: string,
	value: string
): Promise<void> {

	let stackTrace = await dc.stackTraceRequest({ threadId });
	assert.equal(stackTrace.body.stackFrames[0].source!.path, sourcePath);
	assert.equal(stackTrace.body.stackFrames[0].line, line);

	let scopes = await dc.scopesRequest({ 
		frameId: stackTrace.body.stackFrames[0].id
	});
	let variables = await dc.variablesRequest({ 
		variablesReference: scopes.body.scopes[0].variablesReference
	});
	assert.equal(util.findVariable(variables.body.variables, variable).value, value);
}

export function copyFiles(sourceDir: string, targetDir: string, files: string[]) {
	for (let file of files) {
		fs.copySync(path.join(sourceDir, file), path.join(targetDir, file));
	}
}

export function injectScriptTags(targetDir: string, scripts: string[]) {
	let file = path.join(targetDir, 'index.html');
	let content = fs.readFileSync(file, 'utf8');
	let scriptTags = scripts.map((script) => `<script src="${script}"></script>`);
	content = content.replace('__SCRIPTS__', scriptTags.join(''));
	fs.writeFileSync(file, content);
}

export function waitForStreamEnd(s: Stream): Promise<void> {
	return new Promise<void>((resolve) => {
		s.on('end', () => resolve());
	})
}
