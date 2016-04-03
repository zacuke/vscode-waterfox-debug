import { DebugProtocol } from 'vscode-debugprotocol';

export interface WebRootConfiguration {
	request: string;
	url?: string;
	webRoot?: string;
}

export interface LaunchConfiguration extends WebRootConfiguration, DebugProtocol.LaunchRequestArguments {
	file?: string;
	firefoxExecutable?: string;
	profile?: string;
	port?: number;
	firefoxArgs?: string[];
}

export interface AttachConfiguration extends WebRootConfiguration, DebugProtocol.AttachRequestArguments {
	port?: number;
	host?: string;
}
