import * as vscode from 'vscode';
import { LoadedScriptsProvider } from './loadedScripts';

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

	let loadedScriptsProvider = new LoadedScriptsProvider();

	context.subscriptions.push(vscode.debug.onDidReceiveDebugSessionCustomEvent(
		(event) => onCustomEvent(event, loadedScriptsProvider)
	));

	context.subscriptions.push(vscode.window.registerTreeDataProvider(
		'extension.firefox.loadedScripts', loadedScriptsProvider));

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

function onCustomEvent(
	event: vscode.DebugSessionCustomEvent,
	loadedScriptsProvider: LoadedScriptsProvider
) {
	if (event.session.type === 'firefox') {

		switch (event.event) {

			case 'threadStarted':
				loadedScriptsProvider.addThread(<ThreadStartedEventBody>event.body);
				break;

			case 'threadExited':
				loadedScriptsProvider.removeThread((<ThreadExitedEventBody>event.body).id);
				break;

			case 'newSource':
				loadedScriptsProvider.addSource(<NewSourceEventBody>event.body);
				break;
			}
	}
}
