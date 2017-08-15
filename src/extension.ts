import * as vscode from 'vscode';

export function activate(context: vscode.ExtensionContext) {

	context.subscriptions.push(vscode.commands.registerCommand(
		'extension.firefox.reloadAddon', reloadAddon
	));

	context.subscriptions.push(vscode.commands.registerCommand(
		'extension.firefox.rebuildAndReloadAddon', rebuildAndReloadAddon
	));
	
	context.subscriptions.push(vscode.commands.registerCommand(
		'extension.firefox.toggleSkippingFile', toggleSkippingFile
	));
	
}

async function reloadAddon(): Promise<void> {
	await sendCustomRequest('reloadAddon');
}

async function rebuildAndReloadAddon() {
	await sendCustomRequest('rebuildAndReloadAddon');
}

async function toggleSkippingFile(path: string) {
	await sendCustomRequest('toggleSkippingFile', path);
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