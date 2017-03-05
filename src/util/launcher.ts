import { delay } from '../util/misc';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs-extra';
import * as net from 'net';
import { spawn, fork, ChildProcess } from 'child_process';
import * as uuid from 'uuid';
import { LaunchConfiguration } from '../adapter/launchConfiguration';
import { createXpi } from './addon';
import * as FirefoxProfile from 'firefox-profile';

/**
 * Tries to launch Firefox with the given launch configuration.
 * The returned promise resolves to the spawned child process
 * and the addonId if the launch configuration is for addon debugging.
 */
export async function launchFirefox(config: LaunchConfiguration, sendToConsole: (msg: string) => void):
	Promise<ChildProcess | undefined> {

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

	let debugProfileDir = path.join(os.tmpdir(), `vscode-firefox-debug-profile-${uuid.v4()}`);
	firefoxArgs.push('-profile', debugProfileDir);

	await prepareDebugProfile(config, debugProfileDir);

	let childProc: ChildProcess | undefined = undefined;

	if (config.reAttach && (os.platform() === 'win32')) {

		let forkArgs = [...firefoxArgs];
		forkArgs.unshift(firefoxPath);
		let forkedLauncherPath = path.join(__dirname, 'forkedLauncher.js');

		fork(forkedLauncherPath, forkArgs, { execArgv: [] });

	} else {

		childProc = spawn(firefoxPath, firefoxArgs, { detached: true });

		childProc.stdout.on('data', (data) => {
			let msg = (typeof data === 'string') ? data : data.toString('utf8');
			msg = msg.trim();
			sendToConsole(msg);
		});

		childProc.on('exit', () => {
			fs.removeSync(debugProfileDir);
		});

		childProc.unref();
	}

	return childProc;
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

async function prepareDebugProfile(config: LaunchConfiguration, debugProfileDir: string): Promise<string | undefined> {

	var profile = await createDebugProfile(config, debugProfileDir);

	profile.defaultPreferences = {};
	profile.setPreference('browser.shell.checkDefaultBrowser', false);
	profile.setPreference('devtools.chrome.enabled', true);
	profile.setPreference('devtools.debugger.prompt-connection', false);
	profile.setPreference('devtools.debugger.remote-enabled', true);
	profile.setPreference('devtools.debugger.workers', true);
	profile.setPreference('extensions.autoDisableScopes', 10);
	profile.setPreference('xpinstall.signatures.required', false);
	profile.setPreference('extensions.sdk.console.logLevel', 'all');
	profile.updatePreferences();

	if (config.addonType && config.addonPath) {

		let tempXpiDir = path.join(os.tmpdir(), `vscode-firefox-debug-${uuid.v4()}`);
		fs.mkdirSync(tempXpiDir);
		var xpiPath = await createXpi(config.addonType, config.addonPath, tempXpiDir);
		var addonId = await installXpi(profile, xpiPath);
		fs.removeSync(tempXpiDir);

		return addonId;

	} else {
		return undefined;
	}
}

function installXpi(profile: FirefoxProfile, xpiPath: string): Promise<string> {
	return new Promise<string>((resolve, reject) => {
		profile.addExtension(xpiPath, (err, addonDetails) => {
			if (err) {
				reject(err);
			} else {
				resolve(addonDetails!.id);
			}
		})
	});
}

function createDebugProfile(config: LaunchConfiguration, debugProfileDir: string): Promise<FirefoxProfile> {
	return new Promise<FirefoxProfile>((resolve, reject) => {

		if (config.profileDir) {
			
			FirefoxProfile.copy({
				profileDirectory: config.profileDir,
				destinationDirectory: debugProfileDir
			}, 
			(err, profile) => {
				if (err) {
					reject(err);
				} else {
					resolve(profile);
				}
			});

		} else if (config.profile) {

			FirefoxProfile.copyFromUserProfile({
				name: config.profile,
				destinationDirectory: debugProfileDir
			}, 
			(err, profile) => {
				if (err) {
					reject(err);
				} else {
					resolve(profile);
				}
			});

		} else {

			fs.mkdirSync(debugProfileDir);
			resolve(new FirefoxProfile({
				destinationDirectory: debugProfileDir
			}));

		}
	});
}

function isExecutable(path: string): boolean {
	try {
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
