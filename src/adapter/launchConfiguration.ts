import { DebugProtocol } from 'vscode-debugprotocol';
import { LogConfiguration } from '../util/log';

export type AddonType = 'legacy' | 'addonSdk' | 'webExtension';

export interface CommonConfiguration {
	request: string;
	url?: string;
	webRoot?: string;
	reloadOnAttach?: boolean;
	pathMappings?: { url: string, path: string }[];
	skipFiles?: string[];
	log?: LogConfiguration;
	addonType?: AddonType;
	addonPath?: string;
}

export interface LaunchConfiguration extends CommonConfiguration, DebugProtocol.LaunchRequestArguments {
	file?: string;
	firefoxExecutable?: string;
	profileDir?: string;
	profile?: string;
	port?: number;
	firefoxArgs?: string[];
	reAttach?: boolean;
}

export interface AttachConfiguration extends CommonConfiguration, DebugProtocol.AttachRequestArguments {
	port?: number;
	host?: string;
}
