import { delay } from '../util/misc';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs-extra';
import * as net from 'net';
import { spawn, fork, ChildProcess } from 'child_process';
import * as uuid from 'uuid';
import { LaunchConfiguration } from '../adapter/launchConfiguration';
import * as FirefoxProfile from 'firefox-profile';

/**
 * Tries to launch Firefox with the given launch configuration.
 * The returned promise resolves to the resources that should be
 * cleaned up at the end of the debugging session:
 * * the spawned Firefox child process
 * * the path of the temporary profile created for this debugging session
 */
export async function launchFirefox(config: LaunchConfiguration, xpiPath: string | undefined,
	addonBuildPath: string | undefined,
	sendToConsole: (msg: string) => void): Promise<[ChildProcess | undefined, string | undefined]> {

	let firefoxPath = getFirefoxExecutablePath(config);	
	if (!firefoxPath) {
		let errorMsg = 'Couldn\'t find the Firefox executable. ';
		if (config.firefoxExecutable) {
			errorMsg += 'Please correct the path given in your launch configuration.'
		} else {
			errorMsg += 'Please specify the path in your launch configuration.'
		}
		throw errorMsg;
	}

	let port = config.port || 6000;
	let firefoxArgs: string[] = [ '-start-debugger-server', String(port), '-no-remote' ];

	if (Array.isArray(config.firefoxArgs)) {
		firefoxArgs = firefoxArgs.concat(config.firefoxArgs);
	}

	let profile = await prepareDebugProfile(config);

	firefoxArgs.push('-profile', profile.path());

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

	let childProc: ChildProcess | undefined = undefined;

	if (config.reAttach) {

		let directoriesToRemove: string[] = [];
		if (!config.keepProfileChanges) {
			directoriesToRemove.push(profile.path());
		}
		if (addonBuildPath) {
			directoriesToRemove.push(addonBuildPath);
		}

		let forkedLauncherPath = path.join(__dirname, 'forkedLauncher.js');
		let forkArgs: string[];
		switch (directoriesToRemove.length) {
			case 0:
				forkArgs = [
					'spawnDetached', firefoxPath, ...firefoxArgs
				];
				break;

			case 1:
				forkArgs = [
					'spawnDetached', process.execPath, forkedLauncherPath,
					'spawnAndRemove', directoriesToRemove[0], firefoxPath, ...firefoxArgs
				];
				break;

			default:
				forkArgs = [
					'spawnDetached', process.execPath, forkedLauncherPath,
					'spawnAndRemove2', directoriesToRemove[0], directoriesToRemove[1], firefoxPath, ...firefoxArgs
				];
				break;
		}

		fork(forkedLauncherPath, forkArgs, { execArgv: [] });

	} else {

		if (xpiPath !== undefined) {
			await installXpiInProfile(profile, xpiPath);
		}

		childProc = spawn(firefoxPath, firefoxArgs, { detached: true });

		childProc.stdout.on('data', (data) => {
			let msg = (typeof data === 'string') ? data : data.toString('utf8');
			msg = msg.trim();
			sendToConsole(msg);
		});

		childProc.unref();
	}

	let removeProfileOnExit = !config.reAttach && !config.keepProfileChanges;
	return [childProc, (removeProfileOnExit ? profile.path() : undefined)];
}

export async function waitForSocket(port: number): Promise<net.Socket> {
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

async function prepareDebugProfile(config: LaunchConfiguration): Promise<FirefoxProfile> {

	var profile = await createDebugProfile(config);

	profile.defaultPreferences = {};

	let preferences: { [key: string]: boolean | number | string } = {};
	preferences['browser.shell.checkDefaultBrowser'] = false;
	preferences['devtools.chrome.enabled'] = true;
	preferences['devtools.debugger.prompt-connection'] = false;
	preferences['devtools.debugger.remote-enabled'] = true;
	preferences['devtools.debugger.workers'] = true;
	preferences['extensions.autoDisableScopes'] = 10;
	preferences['xpinstall.signatures.required'] = false;
	preferences['extensions.sdk.console.logLevel'] = 'all';

	if (config.preferences !== undefined) {
		for (let key in config.preferences) {
			let value = config.preferences[key];
			if (value !== null) {
				preferences[key] = value;
			} else {
				delete preferences[key];
			}
		}
	}

	for (let key in preferences) {
		profile.setPreference(key, preferences[key]);
	}

	profile.updatePreferences();

	return profile;
}

function installXpiInProfile(profile: FirefoxProfile, xpiPath: string): Promise<string> {
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

function createDebugProfile(config: LaunchConfiguration): Promise<FirefoxProfile> {
	return new Promise<FirefoxProfile>((resolve, reject) => {

		if (config.keepProfileChanges) {

			if (config.addonType) {

				reject('"keepProfileChanges" is currently not supported for add-on debugging');

			} else if (!config.reAttach) {

				reject('To enable "keepProfileChanges" you need to enable "reAttach" as well');

			} else if (config.profileDir) {

				fs.ensureDir(config.profileDir, (err) => {
					if (err) {
						reject(err);
					} else {
						resolve(new FirefoxProfile({ 
							destinationDirectory: config.profileDir
						}));
					}
				});

			} else if (config.profile) {

				let finder = new FirefoxProfile.Finder();
				finder.getPath(config.profile,
				(err, path) => {
					if (err) {
						reject(err);
					} else {
						resolve(new FirefoxProfile({
							destinationDirectory: path
						}));
					}
				});

			} else {

				reject('To enable "keepProfileChanges" you need to set either "profile" or "profileDir"');

			}

		} else {

			let debugProfileDir = path.join(os.tmpdir(), `vscode-firefox-debug-profile-${uuid.v4()}`);

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
		let socket = net.connect(port, host || 'localhost');
		socket.on('connect', () => resolve(socket));
		socket.on('error', reject);
	});
}
