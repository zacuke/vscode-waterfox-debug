import * as vscode from 'vscode';

export function activate(context: vscode.ExtensionContext) {

	context.subscriptions.push(vscode.commands.registerCommand(
		'extension.firefox.reloadAddon', reloadAddon));

	context.subscriptions.push(vscode.commands.registerCommand(
		'extension.firefox.rebuildAndReloadAddon', rebuildAndReloadAddon));

}

function reloadAddon() {
	vscode.commands.executeCommand<void>('workbench.customDebugRequest', 'reloadAddon', {});
}

function rebuildAndReloadAddon() {
	vscode.commands.executeCommand<void>('workbench.customDebugRequest', 'rebuildAndReloadAddon', {});
}
