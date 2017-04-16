import * as vscode from 'vscode';

export function activate(context: vscode.ExtensionContext) {

	context.subscriptions.push(vscode.commands.registerCommand(
		'extension.firefox.reloadAddon', reloadAddon));

	context.subscriptions.push(vscode.commands.registerCommand(
		'extension.firefox.rebuildAndReloadAddon', rebuildAndReloadAddon));

}

async function reloadAddon(): Promise<void> {
	await vscode.commands.executeCommand<void>('workbench.customDebugRequest', 'reloadAddon', {});
}

async function rebuildAndReloadAddon() {
	await vscode.commands.executeCommand<void>('workbench.customDebugRequest', 'rebuildAndReloadAddon', {});
}
