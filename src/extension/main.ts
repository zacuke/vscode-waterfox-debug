import * as vscode from 'vscode';
import { LoadedScriptsProvider } from './loadedScripts';
import { onCustomEvent } from './customEvents';
import { addPathMapping } from './addPathMapping';

export function activate(context: vscode.ExtensionContext) {

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
		'extension.firefox.openScript', openScript
	));

	context.subscriptions.push(vscode.commands.registerCommand(
		'extension.firefox.addPathMapping', addPathMapping
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

async function openScript(pathOrUri: string) {

	let uri: vscode.Uri;
	if (pathOrUri.startsWith('debug:')) {
		uri = vscode.Uri.parse(pathOrUri);
	} else {
		uri = vscode.Uri.file(pathOrUri);
	}

	const doc = await vscode.workspace.openTextDocument(uri);

	vscode.window.showTextDocument(doc);
}
