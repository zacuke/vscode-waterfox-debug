import { DebugProtocol } from 'vscode-debugprotocol';

export interface LaunchConfiguration extends DebugProtocol.LaunchRequestArguments {
	file?: string;
	url?: string;
	webRoot?: string;
	firefoxExecutable?: string;
	profile?: string;
	port?: number;
	firefoxArgs?: string[];
}

export interface AttachConfiguration extends DebugProtocol.AttachRequestArguments {
	port?: number;
}
