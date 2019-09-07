import * as vscode from 'vscode';

export class DebugConfigurationProvider implements vscode.DebugConfigurationProvider {

	/**
	 * this method is called by VS Code before a debug session is started and makes modifications
	 * to the debug configuration:
	 * - some values can be overridden by corresponding VS Code settings
	 * - when running in a remote workspace, we resolve `${workspaceFolder}` ourselves because
	 *   VS Code resolves it to a local path in the remote workspace but we need the remote URI instead
	 */
	resolveDebugConfiguration(
		folder: vscode.WorkspaceFolder | undefined,
		debugConfiguration: vscode.DebugConfiguration
	): vscode.DebugConfiguration {

		debugConfiguration = { ...debugConfiguration };
		const settings = vscode.workspace.getConfiguration('firefox', folder ? folder.uri : null);

		const executable = this.getSetting<string>(settings, 'executable');
		if (executable) {
			debugConfiguration.firefoxExecutable = executable;
		}

		const args = this.getSetting<string[]>(settings, 'args');
		if (args) {
			debugConfiguration.firefoxArgs = args;
		}

		const profileDir = this.getSetting<string>(settings, 'profileDir');
		if (profileDir) {
			debugConfiguration.profileDir = profileDir;
		}

		const profile = this.getSetting<string>(settings, 'profile');
		if (profile) {
			debugConfiguration.profile = profile;
		}

		const keepProfileChanges = this.getSetting<boolean>(settings, 'keepProfileChanges');
		if (keepProfileChanges !== undefined) {
			debugConfiguration.keepProfileChanges = keepProfileChanges;
		}

		if (folder && (folder.uri.scheme === 'vscode-remote')) {

			const uri = folder.uri.toString();
			if (debugConfiguration.webRoot) {
				debugConfiguration.webRoot = debugConfiguration.webRoot.replace('${workspaceFolder}', uri);
			}

			if (debugConfiguration.pathMappings) {

				const resolvedPathMappings: { url: string, path: string | null }[] = [];

				for (const pathMapping of debugConfiguration.pathMappings) {
					resolvedPathMappings.push({
						url: pathMapping.url,
						path: pathMapping.path.replace('${workspaceFolder}', uri)
					});
				}

				debugConfiguration.pathMappings = resolvedPathMappings;
			}
		}

		return debugConfiguration;
	}

	/**
	 * read a value from the user's VS Code settings. If the user hasn't set a value, this
	 * method returns `undefined` (instead of the default value for the given key).
	 */
	private getSetting<T>(settings: vscode.WorkspaceConfiguration, key: string): T | undefined {

		const values = settings.inspect<T>(key);
		if (!values) return undefined;

		if (values.workspaceFolderValue !== undefined) return values.workspaceFolderValue;
		if (values.workspaceValue !== undefined) return values.workspaceValue;
		if (values.globalValue !== undefined) return values.globalValue;
		return undefined;
	}
}
