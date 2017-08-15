import * as vscode from 'vscode';

export function activate(context: vscode.ExtensionContext) {

	context.subscriptions.push(vscode.commands.registerCommand(
		'extension.firefox.reloadAddon', () => sendCustomRequest('reloadAddon')
	));

	context.subscriptions.push(vscode.commands.registerCommand(
		'extension.firefox.rebuildAndReloadAddon', () => sendCustomRequest('rebuildAndReloadAddon')
	));
	
	context.subscriptions.push(vscode.commands.registerCommand(
		'extension.firefox.toggleSkippingFile', (path) => sendCustomRequest('toggleSkippingFile', path)
	));

	context.subscriptions.push(vscode.debug.onDidReceiveDebugSessionCustomEvent(onCustomEvent));

}

async function sendCustomRequest(command: string, args?: any) {
	let debugSession = vscode.debug.activeDebugSession;
	if (debugSession && (debugSession.type === 'firefox')) {
		await debugSession.customRequest(command, args);
	} else {
		if (debugSession) {
			throw 'The active debug session is not of type "firefox"';
		} else {
			throw 'There is no active debug session';
		}
	}
}

export interface ThreadStartedEventBody {
	name: string;
	id: number;
}

export interface ThreadExitedEventBody {
	id: number;
}

export interface NewSourceEventBody {
	threadId: number;
	sourceId: number;
	url: string | undefined;
	path: string | undefined;
}

function onCustomEvent(event: vscode.DebugSessionCustomEvent) {
	if (event.session.type === 'firefox') {

		switch (event.event) {

			case 'threadStarted':
				onThreadStarted(<ThreadStartedEventBody>event.body);
				break;

			case 'threadExited':
				onThreadExited(<ThreadExitedEventBody>event.body);
				break;

			case 'newSource':
				onNewSource(<NewSourceEventBody>event.body);
				break;
			}
	}
}

function onThreadStarted(body: ThreadStartedEventBody) {
}

function onThreadExited(body: ThreadExitedEventBody) {
}

function onNewSource(body: NewSourceEventBody) {
}
