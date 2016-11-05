import { delay } from '../util/misc';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs-extra';
import * as net from 'net';
import { spawn, ChildProcess } from 'child_process';
import * as uuid from 'node-uuid';
import { LaunchConfiguration } from '../adapter/launchConfiguration';
import * as ProfileFinder from 'firefox-profile/lib/profile_finder';
import { installAddon } from './addon';

/**
 * Tries to launch Firefox with the given launch configuration.
 * The returned promise resolves to the spawned child process.
 */
export function launchFirefox(config: LaunchConfiguration, addonId: string): 
	Promise<ChildProcess> {

	let firefoxPath = getFirefoxExecutablePath(config);	
	if (!firefoxPath) {
		let errorMsg = 'Couldn\'t find the Firefox executable. ';
		if (config.firefoxExecutable) {
			errorMsg += 'Please correct the path given in your launch configuration.'
		} else {
			errorMsg += 'Please specify the path in your launch configuration.'
		}
		return Promise.reject(errorMsg);
	}

	let port = config.port || 6000;
	let firefoxArgs: string[] = [ '-start-debugger-server', String(port), '-no-remote' ];

	if (Array.isArray(config.firefoxArgs)) {
		firefoxArgs = firefoxArgs.concat(config.firefoxArgs);
	}

	if (config.file) {

		if (!path.isAbsolute(config.file)) {
			return Promise.reject('The "file" property in the launch configuration has to be an absolute path');
		}

		let fileUrl = config.file;
		if (os.platform() === 'win32') {
			fileUrl = 'file:///' + fileUrl.replace(/\\/g, '/');
		} else {
			fileUrl = 'file://' + fileUrl;
		}
		firefoxArgs.push(fileUrl);

	} else if (config.url) {
		firefoxArgs.push(config.url);
	} else if (config.addonType) {
		firefoxArgs.push('about:blank');
	} else {
		return Promise.reject('You need to set either "file" or "url" in the launch configuration');
	}

	return createDebugProfile(config, addonId).then((debugProfileDir) => {

		firefoxArgs.push('-profile', debugProfileDir);

		let childProc = spawn(firefoxPath!, firefoxArgs, { detached: true, stdio: 'ignore' });
		childProc.on('exit', () => {
			fs.removeSync(debugProfileDir);
		});
		childProc.unref();
		return childProc;

	});
}

export async function waitForSocket(config: LaunchConfiguration): Promise<net.Socket> {
	let port = config.port || 6000;
	let lastError: any;
	for (var i = 0; i < 25; i++) {
		try {
			return await connect(port);
		} catch(err) {
			lastError = err;
			await delay(200);
		}
	}
	throw lastError;
}

function getFirefoxExecutablePath(config: LaunchConfiguration): string | undefined {

	if (config.firefoxExecutable) {
		if (isExecutable(config.firefoxExecutable)) {
			return config.firefoxExecutable;
		} else {
			return undefined;
		}
	}
	
	let candidates: string[] = [];
	switch (os.platform()) {
		
		case 'linux':
		case 'freebsd':
		case 'sunos':
			candidates = [
				'/usr/bin/firefox-developer',
				'/usr/bin/firefox'
			]
			break;

		case 'darwin':
			candidates = [
				'/Applications/FirefoxDeveloperEdition.app/Contents/MacOS/firefox',
				'/Applications/Firefox.app/Contents/MacOS/firefox'
			]
			break;

		case 'win32':
			candidates = [
				'C:\\Program Files (x86)\\Firefox Developer Edition\\firefox.exe',
				'C:\\Program Files\\Firefox Developer Edition\\firefox.exe',
				'C:\\Program Files (x86)\\Mozilla Firefox\\firefox.exe',
				'C:\\Program Files\\Mozilla Firefox\\firefox.exe'
			]
			break;
	}

	for (let i = 0; i < candidates.length; i++) {
		if (isExecutable(candidates[i])) {
			return candidates[i];
		}
	}
	
	return undefined;
}

function createDebugProfile(config: LaunchConfiguration, addonId: string): Promise<string> {

	let debugProfileDir = path.join(os.tmpdir(), `vscode-firefox-debug-profile-${uuid.v4()}`);

	let createProfilePromise: Promise<void>;
	if (config.profileDir) {

		if (!isReadableDirectory(config.profileDir)) {
			return Promise.reject(`Couldn't access profile directory ${config.profileDir}`);
		}

		fs.copySync(config.profileDir, debugProfileDir, {
			clobber: true,
			filter: isNotLockFile
		});
		createProfilePromise = Promise.resolve(undefined);

	} else if (config.profile) {

		createProfilePromise = new Promise<void>((resolve, reject) => {

			var finder = new ProfileFinder();
			finder.getPath(config.profile!, (err, profileDir) => {

				if (err) {
					reject(`Couldn't find profile '${config.profile}'`);
				} else if (!isReadableDirectory(profileDir)) {
					reject(`Couldn't access profile '${config.profile}'`);
				} else {

					fs.copySync(profileDir, debugProfileDir, {
						clobber: true,
						filter: isNotLockFile
					});
					resolve(undefined);

				}
			});
		});

	} else {

		fs.mkdirSync(debugProfileDir);
		createProfilePromise = Promise.resolve(undefined);

	}

	return createProfilePromise.then(() => {

		fs.writeFileSync(path.join(debugProfileDir, 'user.js'), firefoxUserPrefs);

		if (addonId) {

			return installAddon(config.addonType!, addonId, config.addonPath!, debugProfileDir)
				.then(() => debugProfileDir);

		} else {
			return debugProfileDir;
		}
	});
}

function isNotLockFile(filePath: string) {
	var file = path.basename(filePath);
	return !/^(parent\.lock|lock|\.parentlock)$/.test(file);
}

let firefoxUserPrefs = `
user_pref("browser.shell.checkDefaultBrowser", false);
user_pref("devtools.chrome.enabled", true);
user_pref("devtools.debugger.prompt-connection", false);
user_pref("devtools.debugger.remote-enabled", true);
user_pref("devtools.debugger.workers", true);
user_pref("extensions.autoDisableScopes", 10);
user_pref("xpinstall.signatures.required", false);
`;

function isExecutable(path: string): boolean {
	try {
		fs.accessSync(path, fs.constants.X_OK);
		return true;
	} catch (e) {
		return false;
	}
}

function isReadableDirectory(path: string): boolean {
	try {
		let stat = fs.statSync(path);
		if (!stat.isDirectory) {
			return false;
		}
		fs.accessSync(path, fs.constants.X_OK);
		return true;
	} catch (e) {
		return false;
	}
}

export function connect(port: number, host?: string): Promise<net.Socket> {
	return new Promise<net.Socket>((resolve, reject) => {
		let socket = net.connect(port);
		socket.on('connect', () => resolve(socket));
		socket.on('error', reject);
	});
}
