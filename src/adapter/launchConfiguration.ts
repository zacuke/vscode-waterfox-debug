import { DebugProtocol } from 'vscode-debugprotocol';
import { LogConfiguration } from '../util/log';

export interface CommonConfiguration {
	request: string;
	url?: string;
	webRoot?: string;
	log?: LogConfiguration;
	addonType?: 'legacy' | 'addonSdk' | 'webExtension';
	addonPath?: string;
}

export interface LaunchConfiguration extends CommonConfiguration, DebugProtocol.LaunchRequestArguments {
	file?: string;
	firefoxExecutable?: string;
	profileDir?: string;
	profile?: string;
	port?: number;
	firefoxArgs?: string[];
}

export interface AttachConfiguration extends CommonConfiguration, DebugProtocol.AttachRequestArguments {
	port?: number;
	host?: string;
}
