import * as vscode from 'vscode';
import { LoadedScriptsProvider, TreeNode } from './loadedScripts';
import { ConfigurationTarget } from 'vscode';

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

interface LaunchConfig {
	type: string;
	name: string;
}

interface LaunchConfigReference {
	workspaceFolder: vscode.WorkspaceFolder;
	launchConfigFile: vscode.WorkspaceConfiguration;
	index: number;
}

async function addPathMapping(treeNode: TreeNode): Promise<void> {

	const debugSession = vscode.debug.activeDebugSession;
	if (!debugSession) {
		vscode.window.showErrorMessage('No active debug session');
		return;
	}

	const workspaceFolders = vscode.workspace.workspaceFolders;
	if (!workspaceFolders) {
		vscode.window.showErrorMessage('No open folder');
		return;
	}

	const launchConfigReference = findLaunchConfig(workspaceFolders, debugSession);

	if (!launchConfigReference) {
		vscode.window.showErrorMessage(`Couldn't find configuration for active debug session '${debugSession.name}'`);
		return;
	}

	const openDialogResult = await vscode.window.showOpenDialog({
		canSelectFiles: false,
		canSelectFolders: true,
		canSelectMany: false,
		defaultUri: launchConfigReference.workspaceFolder.uri,
		openLabel: 'Map to this folder'
	});
	if (!openDialogResult || (openDialogResult.length === 0)) {
		return;
	}
	const path = openDialogResult[0].fsPath;

	addPathMappingToLaunchConfig(launchConfigReference, treeNode.getFullPath(), path + '/');
}

function findLaunchConfig(
	workspaceFolders: vscode.WorkspaceFolder[],
	activeDebugSession: vscode.DebugSession
): LaunchConfigReference | undefined {

	for (const workspaceFolder of workspaceFolders) {
		const launchConfigFile = vscode.workspace.getConfiguration('launch', workspaceFolder.uri);
		const launchConfigs: LaunchConfig[] | undefined = launchConfigFile.get('configurations');
		if (launchConfigs) {
			for (let index = 0; index < launchConfigs.length; index++) {
				if ((launchConfigs[index].type === activeDebugSession.type) && 
					(launchConfigs[index].name === activeDebugSession.name)) {
					return { workspaceFolder, launchConfigFile, index };
				}
			}
		}
	}

	return undefined;
}

function addPathMappingToLaunchConfig(
	launchConfigReference: LaunchConfigReference,
	url: string,
	path: string
): void {

	const configurations = <any[]>launchConfigReference.launchConfigFile.get('configurations');
	const configuration = configurations[launchConfigReference.index];

	if (!configuration.pathMappings) {
		configuration.pathMappings = [];
	}

	const workspacePath = launchConfigReference.workspaceFolder.uri.fsPath;
	if (path.startsWith(workspacePath)) {
		path = '${workspaceFolder}' + path.substr(workspacePath.length);
	}

	const pathMappings: any[] = configuration.pathMappings;
	pathMappings.unshift({ url, path });

	launchConfigReference.launchConfigFile.update('configurations', configurations, ConfigurationTarget.WorkspaceFolder);
}
