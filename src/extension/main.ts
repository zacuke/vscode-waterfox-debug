import * as vscode from 'vscode';
import isAbsoluteUrl from 'is-absolute-url';
import { LoadedScriptsProvider } from './loadedScripts/provider';
import { ThreadStartedEventBody, ThreadExitedEventBody, NewSourceEventBody, RemoveSourcesEventBody, PopupAutohideEventBody } from '../common/customEvents';
import { addPathMapping, addNullPathMapping } from './addPathMapping';
import { PopupAutohideManager } from './popupAutohideManager';
import { DebugConfigurationProvider } from './debugConfigurationProvider';
import { createPathMappingForActiveTextEditor, createPathMappingForPath } from './pathMappingWizard';

export function activate(context: vscode.ExtensionContext) {

	const loadedScriptsProvider = new LoadedScriptsProvider();
	const popupAutohideManager = new PopupAutohideManager(sendCustomRequest);
	const debugConfigurationProvider = new DebugConfigurationProvider();

	context.subscriptions.push(vscode.window.registerTreeDataProvider(
		'extension.waterfox.loadedScripts', loadedScriptsProvider
	));

	context.subscriptions.push(vscode.debug.registerDebugConfigurationProvider(
		'waterfox', debugConfigurationProvider
	));

	context.subscriptions.push(vscode.commands.registerCommand(
		'extension.waterfox.reloadAddon', () => sendCustomRequest('reloadAddon')
	));

	context.subscriptions.push(vscode.commands.registerCommand(
		'extension.waterfox.toggleSkippingFile', (url) => sendCustomRequest('toggleSkippingFile', url)
	));

	context.subscriptions.push(vscode.commands.registerCommand(
		'extension.waterfox.openScript', openScript
	));

	context.subscriptions.push(vscode.commands.registerCommand(
		'extension.waterfox.addPathMapping', addPathMapping
	));

	context.subscriptions.push(vscode.commands.registerCommand(
		'extension.waterfox.addFilePathMapping', addPathMapping
	));

	context.subscriptions.push(vscode.commands.registerCommand(
		'extension.waterfox.addNullPathMapping', addNullPathMapping
	));

	context.subscriptions.push(vscode.commands.registerCommand(
		'extension.waterfox.addNullFilePathMapping', addNullPathMapping
	));

	context.subscriptions.push(vscode.commands.registerCommand(
		'extension.waterfox.enablePopupAutohide', () => popupAutohideManager.setPopupAutohide(true)
	));

	context.subscriptions.push(vscode.commands.registerCommand(
		'extension.waterfox.disablePopupAutohide', () => popupAutohideManager.setPopupAutohide(false)
	));

	context.subscriptions.push(vscode.commands.registerCommand(
		'extension.waterfox.togglePopupAutohide', () => popupAutohideManager.togglePopupAutohide()
	));

	context.subscriptions.push(vscode.commands.registerCommand(
		'extension.waterfox.pathMappingWizard', () => createPathMappingForActiveTextEditor(loadedScriptsProvider)
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
	if (debugSession && (debugSession.type === 'waterfox')) {
		return await debugSession.customRequest(command, args);
	} else {
		if (debugSession) {
			vscode.window.showErrorMessage('The active debug session is not of type "waterfox"');
		} else {
			vscode.window.showErrorMessage('There is no active debug session');
		}
	}
}

let activeWaterfoxDebugSessions = 0;

function onDidStartSession(
	session: vscode.DebugSession,
	loadedScriptsProvider: LoadedScriptsProvider
) {
	if (session.type === 'waterfox') {
		loadedScriptsProvider.addSession(session);
		activeWaterfoxDebugSessions++;
	}
}

function onDidTerminateSession(
	session: vscode.DebugSession,
	loadedScriptsProvider: LoadedScriptsProvider,
	popupAutohideManager: PopupAutohideManager
) {
	if (session.type === 'waterfox') {
		loadedScriptsProvider.removeSession(session.id);
		activeWaterfoxDebugSessions--;
		if (activeWaterfoxDebugSessions === 0) {
			popupAutohideManager.disableButton();
		}
	}
}

function onCustomEvent(
	event: vscode.DebugSessionCustomEvent,
	loadedScriptsProvider: LoadedScriptsProvider,
	popupAutohideManager: PopupAutohideManager
) {
	if (event.session.type === 'waterfox') {

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

			case 'popupAutohide':
				popupAutohideManager.enableButton((<PopupAutohideEventBody>event.body).popupAutohide);
				break;

			case 'unknownSource':
				createPathMappingForPath(event.body, event.session, loadedScriptsProvider);
				break;
		}
	}
}

async function openScript(pathOrUri: string) {

	let uri: vscode.Uri;
	if (isAbsoluteUrl(pathOrUri)) {
		uri = vscode.Uri.parse(pathOrUri);
	} else {
		uri = vscode.Uri.file(pathOrUri);
	}

	const doc = await vscode.workspace.openTextDocument(uri);

	vscode.window.showTextDocument(doc);
}
