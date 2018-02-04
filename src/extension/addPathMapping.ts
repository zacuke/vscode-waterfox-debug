import * as path from 'path';
import * as vscode from 'vscode';
import { TreeNode } from './loadedScripts/treeNode';

interface LaunchConfig {
	type: string;
	name: string;
}

interface LaunchConfigReference {
	workspaceFolder: vscode.WorkspaceFolder;
	launchConfigFile: vscode.WorkspaceConfiguration;
	index: number;
}

export async function addPathMapping(treeNode: TreeNode): Promise<void> {

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

	await showLaunchConfig(launchConfigReference.workspaceFolder);
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

	launchConfigReference.launchConfigFile.update('configurations', configurations, vscode.ConfigurationTarget.WorkspaceFolder);
}

async function showLaunchConfig(workspaceFolder: vscode.WorkspaceFolder): Promise<void> {
	const file = path.join(workspaceFolder.uri.fsPath, '.vscode/launch.json');
	const document = await vscode.workspace.openTextDocument(file);
	await vscode.window.showTextDocument(document);
}
