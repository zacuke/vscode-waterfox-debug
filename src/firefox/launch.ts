import * as path from 'path';
import * as fs from 'fs-extra';
import { spawn, fork, ChildProcess } from 'child_process';
import * as FirefoxProfile from 'firefox-profile';
import { ParsedLaunchConfiguration } from '../configuration';
import { AddonManager } from "../adapter/addonManager";

export async function launchFirefox(
	launch: ParsedLaunchConfiguration,
	sendToConsole: (msg: string) => void,
	addonManager?: AddonManager
): Promise<ChildProcess | undefined> {

	let profile = await prepareDebugProfile(launch);
	if (addonManager) {
		await addonManager.profilePrepared(profile);
	}

	let childProc: ChildProcess | undefined = undefined;

	if (launch.detached) {

		let forkedLauncherPath = path.join(__dirname, '../util/forkedLauncher.js');
		let forkArgs: string[];
		switch (launch.tmpDirs.length) {
			case 0:
				forkArgs = [
					'spawnDetached', launch.firefoxExecutable, ...launch.firefoxArgs
				];
				break;

			case 1:
				forkArgs = [
					'spawnDetached', process.execPath, forkedLauncherPath,
					'spawnAndRemove', launch.tmpDirs[0], launch.firefoxExecutable, ...launch.firefoxArgs
				];
				break;

			default:
				forkArgs = [
					'spawnDetached', process.execPath, forkedLauncherPath,
					'spawnAndRemove2', launch.tmpDirs[0], launch.tmpDirs[1], launch.firefoxExecutable, ...launch.firefoxArgs
				];
				break;
		}

		fork(forkedLauncherPath, forkArgs, { execArgv: [] });

	} else {

		childProc = spawn(launch.firefoxExecutable, launch.firefoxArgs, { detached: true });

		childProc.stdout.on('data', (data) => {
			let msg = (typeof data === 'string') ? data : data.toString('utf8');
			msg = msg.trim();
			sendToConsole(msg);
		});

		childProc.unref();
	}

	return childProc;
}

async function prepareDebugProfile(config: ParsedLaunchConfiguration): Promise<FirefoxProfile> {

	var profile = await createDebugProfile(config);

	for (let key in config.preferences) {
		profile.setPreference(key, config.preferences[key]);
	}

	profile.updatePreferences();

	return profile;
}

function createDebugProfile(config: ParsedLaunchConfiguration): Promise<FirefoxProfile> {
	return new Promise<FirefoxProfile>(async (resolve, reject) => {

		if (config.srcProfileDir) {

			FirefoxProfile.copy({
				profileDirectory: config.srcProfileDir,
				destinationDirectory: config.profileDir
			}, 
			(err, profile) => {
				if (err || !profile) {
					reject(err);
				} else {
					profile.shouldDeleteOnExit(false);
					resolve(profile);
				}
			});

		} else {

			await fs.ensureDir(config.profileDir);
			let profile = new FirefoxProfile({
				destinationDirectory: config.profileDir
			});
			profile.shouldDeleteOnExit(false);
			resolve(profile);
		}
	});
}
