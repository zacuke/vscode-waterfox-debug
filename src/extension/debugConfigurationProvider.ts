import * as vscode from 'vscode';

export class DebugConfigurationProvider implements vscode.DebugConfigurationProvider {

	resolveDebugConfiguration(
		folder: vscode.WorkspaceFolder | undefined,
		debugConfiguration: vscode.DebugConfiguration
	): vscode.DebugConfiguration {

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

		return debugConfiguration;
	}

	private getSetting<T>(settings: vscode.WorkspaceConfiguration, key: string): T | undefined {

		const values = settings.inspect<T>(key);
		if (!values) return undefined;

		if (values.workspaceFolderValue !== undefined) return values.workspaceFolderValue;
		if (values.workspaceValue !== undefined) return values.workspaceValue;
		if (values.globalValue !== undefined) return values.globalValue;
		return undefined;
	}
}
