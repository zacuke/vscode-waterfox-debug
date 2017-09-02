import * as vscode from 'vscode';
import { LoadedScriptsProvider } from './loadedScripts';

export function activate(context: vscode.ExtensionContext) {

	context.subscriptions.push(vscode.commands.registerCommand(
		'extension.firefox.startDebug', startDebug
	));

	context.subscriptions.push(vscode.commands.registerCommand(
		'extension.firefox.reloadAddon', () => sendCustomRequest('reloadAddon')
	));

	context.subscriptions.push(vscode.commands.registerCommand(
		'extension.firefox.rebuildAndReloadAddon', () => sendCustomRequest('rebuildAndReloadAddon')
	));

	context.subscriptions.push(vscode.commands.registerCommand(
		'extension.firefox.toggleSkippingFile', (url) => sendCustomRequest('toggleSkippingFile', url)
	));

	context.subscriptions.push(vscode.commands.registerCommand(
		'extension.firefox.openLocalScript', openLocalScript
	));

	context.subscriptions.push(vscode.commands.registerCommand(
		'extension.firefox.openRemoteScript', openRemoteScript
	));

	let loadedScriptsProvider = new LoadedScriptsProvider();

	context.subscriptions.push(vscode.debug.onDidReceiveDebugSessionCustomEvent(
		(event) => onCustomEvent(event, loadedScriptsProvider)
	));

	context.subscriptions.push(vscode.debug.onDidStartDebugSession(
		(session) => onDidStartSession(session, loadedScriptsProvider)
	));

	context.subscriptions.push(vscode.debug.onDidTerminateDebugSession(
		(session) => onDidTerminateSession(session, loadedScriptsProvider)
	));

	context.subscriptions.push(vscode.window.registerTreeDataProvider(
		'extension.firefox.loadedScripts', loadedScriptsProvider));

}

function startDebug(configuration: vscode.DebugConfiguration, workspaceUri: vscode.Uri | null) {
	vscode.commands.executeCommand('vscode.startDebug', configuration, workspaceUri);
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

export interface RemoveSourcesEventBody {
	threadId: number;
}

function onCustomEvent(
	event: vscode.DebugSessionCustomEvent,
	loadedScriptsProvider: LoadedScriptsProvider
) {
	if (event.session.type === 'firefox') {

		switch (event.event) {

			case 'threadStarted':
				loadedScriptsProvider.addThread(<ThreadStartedEventBody>event.body, event.session.id);
				break;

			case 'threadExited':
				loadedScriptsProvider.removeThread((<ThreadExitedEventBody>event.body).id, event.session.id);
				break;

			case 'newSource':
				loadedScriptsProvider.addSource(<NewSourceEventBody>event.body, event.session.id);
				break;

			case 'removeSources':
				loadedScriptsProvider.removeSources((<RemoveSourcesEventBody>event.body).threadId, event.session.id);
				break;
		}
	}
}

function onDidStartSession(
	session: vscode.DebugSession,
	loadedScriptsProvider: LoadedScriptsProvider
) {
	if (session.type === 'firefox') {
		loadedScriptsProvider.addSession(session);
	}
}

function onDidTerminateSession(
	session: vscode.DebugSession,
	loadedScriptsProvider: LoadedScriptsProvider
) {
	if (session.type === 'firefox') {
		loadedScriptsProvider.removeSession(session.id);
	}
}

function openLocalScript(path: string, sessionId: string) {
	vscode.workspace.openTextDocument(path).then((doc) => vscode.window.showTextDocument(doc));
}

function openRemoteScript(filename: string, sourceId: number, sessionId: string) {
	let uri = vscode.Uri.parse(`debug:${sourceId}/${filename.split('?')[0]}?session=${sessionId}`);
	vscode.workspace.openTextDocument(uri).then((doc) => vscode.window.showTextDocument(doc));
}
