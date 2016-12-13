import { delay } from '../util/misc';
import { DebugClient } from 'vscode-debugadapter-testsupport';
import { DebugProtocol } from 'vscode-debugprotocol';
import { AddonType } from '../adapter/launchConfiguration';
import * as path from 'path';

export async function initDebugClient(testDataPath: string, waitForPageLoadedEvent: boolean): Promise<DebugClient> {

	let dc = new DebugClient('node', './out/firefoxDebugAdapter.js', 'firefox');

	await dc.start();
	await Promise.all([
		dc.launch({ file: path.join(testDataPath, 'web/index.html') }),
		dc.configurationSequence()
	]);

	if (waitForPageLoadedEvent) {
		await receivePageLoadedEvent(dc);
	}

	return dc;
}

export async function initDebugClientForAddon(testDataPath: string, addonType: AddonType, waitForPageLoadedEvent: boolean): Promise<DebugClient> {

	let dc = new DebugClient('node', './out/firefoxDebugAdapter.js', 'firefox');

	await dc.start();
	await Promise.all([
		dc.launch({
			addonType,
			addonPath: path.join(testDataPath, `${addonType}/addOn`),
			file: path.join(testDataPath, `${addonType}/index.html`)
		}),
		dc.waitForEvent('initialized', 20000)
	]);
	dc.setExceptionBreakpointsRequest({ filters: [] });

	if (waitForPageLoadedEvent) {
		await receivePageLoadedEvent(dc);
	}

	return dc;
}

export async function receivePageLoadedEvent(dc: DebugClient): Promise<void> {
	let ev = await dc.waitForEvent('output');
	let outputMsg = ev.body.output.trim();
	if (outputMsg !== 'Loaded') {
		throw new Error(`Wrong output message '${outputMsg}'`);
	}
}

export function setBreakpoints(dc: DebugClient, sourcePath: string, breakpointLines: number[]): Promise<DebugProtocol.SetBreakpointsResponse> {
	return dc.setBreakpointsRequest({
		source: { path: sourcePath },
		breakpoints: breakpointLines.map((line) => { return { line }; })
	});
}

export function receiveBreakpointEvent(dc: DebugClient): Promise<DebugProtocol.BreakpointEvent> {
	return dc.waitForEvent('breakpoint');
}

export function receiveStoppedEvent(dc: DebugClient): Promise<DebugProtocol.StoppedEvent> {
	return dc.waitForEvent('stopped');
}

export function evaluate(dc: DebugClient, js: string): Promise<DebugProtocol.EvaluateResponse> {
	return dc.evaluateRequest({ context: 'repl', expression: js });
}

export function evaluateDelayed(dc: DebugClient, js: string, delay: number): Promise<DebugProtocol.EvaluateResponse> {
	js = `setTimeout(function() { ${js} }, ${delay})`;
	return evaluate(dc, js);
}

export async function assertPromiseTimeout(promise: Promise<any>, timeout: number): Promise<void> {
	let promiseResolved = await Promise.race([
		promise.then(() => true),
		delay(timeout).then(() => false)
	]);
	if (promiseResolved) {
		throw new Error(`The Promise was resolved within ${timeout}ms`);
	}
}

export function findVariable(variables: DebugProtocol.Variable[], varName: string): DebugProtocol.Variable {
	for (var i = 0; i < variables.length; i++) {
		if (variables[i].name === varName) {
			return variables[i];
		}
	}
	throw new Error(`Variable '${varName}' not found`);
}
