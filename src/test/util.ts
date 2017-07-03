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

export async function initDebugClientForAddon(testDataPath: string, addonType: AddonType, delayedNavigation = false): Promise<DebugClient> {

	let dcArgs = { addonType, addonPath: path.join(testDataPath, `${addonType}/addOn`) };
	if (delayedNavigation) {
		dcArgs['file'] = path.join(testDataPath, `web/index.html`);
	} else {
		dcArgs['file'] = path.join(testDataPath, `${addonType}/index.html`);
	}

	let dc = new DebugClient('node', './out/firefoxDebugAdapter.js', 'firefox');

	await dc.start();
	await Promise.all([
		dc.launch(dcArgs),
		dc.waitForEvent('initialized', 20000)
	]);
	dc.setExceptionBreakpointsRequest({ filters: [] });

	await receivePageLoadedEvent(dc, (addonType === 'addonSdk'));

	if (delayedNavigation) {
		await setConsoleThread(dc, await findTabThread(dc));
		let file = path.join(testDataPath, `${addonType}/index.html`);
		await evaluate(dc, `location="file://${file}"`);
		await receivePageLoadedEvent(dc, (addonType === 'addonSdk'));
	}

	return dc;
}

export async function receivePageLoadedEvent(dc: DebugClient, lenient: boolean = false): Promise<void> {
	let ev = await dc.waitForEvent('output', 10000);
	let outputMsg = ev.body.output.trim();
	if (outputMsg !== 'Loaded') {
		if (lenient) {
			await receivePageLoadedEvent(dc, true);
		} else {
			throw new Error(`Wrong output message '${outputMsg}'`);
		}
	}
}

export function setBreakpoints(dc: DebugClient, sourcePath: string, breakpointLines: number[]): Promise<DebugProtocol.SetBreakpointsResponse> {
	return dc.setBreakpointsRequest({
		source: { path: sourcePath },
		breakpoints: breakpointLines.map((line) => { return { line }; })
	});
}

export function receiveBreakpointEvent(dc: DebugClient): Promise<DebugProtocol.Event> {
	return dc.waitForEvent('breakpoint', 10000);
}

export function receiveStoppedEvent(dc: DebugClient): Promise<DebugProtocol.Event> {
	return dc.waitForEvent('stopped', 10000);
}

export async function runCommandAndReceiveStoppedEvent(dc: DebugClient, command: () => void): Promise<DebugProtocol.Event> {
	let stoppedEventPromise = dc.waitForEvent('stopped', 10000);
	command();
	return await stoppedEventPromise;
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

export async function findTabThread(dc: DebugClient): Promise<number> {
	let threadsPresponse = await dc.threadsRequest();
	for (let thread of threadsPresponse.body.threads) {
		if (thread.name.startsWith('Tab')) {
			return thread.id;
		}
	}
	throw new Error('Couldn\'t find a tab thread');
}

export async function setConsoleThread(dc: DebugClient, threadId: number): Promise<void> {
	try {
		await dc.stackTraceRequest({ threadId });
	} catch(e) {}
}
