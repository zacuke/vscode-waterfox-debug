import * as vscode from 'vscode';
import { LoadedScriptsProvider } from './loadedScripts/provider';
import { onCustomEvent } from './customEvents';
import { addPathMapping } from './addPathMapping';
import { PopupAutohideManager } from './popupAutohideManager';

export function activate(context: vscode.ExtensionContext) {

	const loadedScriptsProvider = new LoadedScriptsProvider();
	const popupAutohideManager = new PopupAutohideManager(sendCustomRequest);

	context.subscriptions.push(vscode.window.registerTreeDataProvider(
		'extension.firefox.loadedScripts', loadedScriptsProvider));

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

	context.subscriptions.push(vscode.commands.registerCommand(
		'extension.firefox.enablePopupAutohide', () => popupAutohideManager.setPopupAutohide(true)
	));

	context.subscriptions.push(vscode.commands.registerCommand(
		'extension.firefox.disablePopupAutohide', () => popupAutohideManager.setPopupAutohide(false)
	));

	context.subscriptions.push(vscode.commands.registerCommand(
		'extension.firefox.togglePopupAutohide', () => popupAutohideManager.togglePopupAutohide()
	));

	context.subscriptions.push(vscode.debug.onDidReceiveDebugSessionCustomEvent(
		(event) => onCustomEvent(event, loadedScriptsProvider, popupAutohideManager)
	));

	context.subscriptions.push(vscode.debug.onDidStartDebugSession(
		(session) => onDidStartSession(session, loadedScriptsProvider)
	));

	context.subscriptions.push(vscode.debug.onDidTerminateDebugSession(
		(session) => onDidTerminateSession(session, loadedScriptsProvider, popupAutohideManager)
	));
}

async function sendCustomRequest(command: string, args?: any): Promise<any> {
	let debugSession = vscode.debug.activeDebugSession;
	if (debugSession && (debugSession.type === 'firefox')) {
		return await debugSession.customRequest(command, args);
	} else {
		if (debugSession) {
			throw 'The active debug session is not of type "firefox"';
		} else {
			throw 'There is no active debug session';
		}
	}
}

let activeFirefoxDebugSessions = 0;

function onDidStartSession(
	session: vscode.DebugSession,
	loadedScriptsProvider: LoadedScriptsProvider
) {
	if (session.type === 'firefox') {
		loadedScriptsProvider.addSession(session);
		activeFirefoxDebugSessions++;
	}
}

function onDidTerminateSession(
	session: vscode.DebugSession,
	loadedScriptsProvider: LoadedScriptsProvider,
	popupAutohideManager: PopupAutohideManager
) {
	if (session.type === 'firefox') {
		loadedScriptsProvider.removeSession(session.id);
		activeFirefoxDebugSessions--;
		if (activeFirefoxDebugSessions === 0) {
			popupAutohideManager.disableButton();
		}
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
