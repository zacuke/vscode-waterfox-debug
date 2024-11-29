import * as path from 'path';
import * as fs from 'fs-extra';
import { spawn, fork, ChildProcess } from 'child_process';
import WaterfoxProfile from 'waterfox-profile';
import { ParsedLaunchConfiguration, ParsedAttachConfiguration, getExecutableCandidates } from '../configuration';
import { isExecutable } from '../util/fs';

/**
 * Launches Waterfox after preparing the debug profile.
 * If Waterfox is launched "detached" (the default unless we are on MacOS and the `reAttach` flag
 * in the launch configuration is set to `false`), it creates one or even two intermediate
 * child processes for launching Waterfox:
 * * one of them will wait for the Waterfox process to exit and then remove any temporary directories
 *   created by this debug adapter
 * * the other one is used to work around a bug in the node version that is distributed with VS Code
 *   (and that runs this debug adapter), which fails to properly detach from child processes.
 *   See [this issue](https://github.com/microsoft/vscode/issues/22022) for an explanation of the
 *   bug and how to work around it.
 * 
 * The intermediate child processes execute the [forkedLauncher](../util/forkedLauncher.ts) script.
 */
export async function launchWaterfox(launch: ParsedLaunchConfiguration): Promise<ChildProcess | undefined> {

	await prepareDebugProfile(launch);

	// workaround for an issue with the snap version of VS Code
	// (see e.g. https://github.com/microsoft/vscode/issues/85344)
	const env = { ...process.env };
	if (env.SNAP) {
		delete env['GDK_PIXBUF_MODULE_FILE'];
		delete env['GDK_PIXBUF_MODULEDIR'];
	}

	let childProc: ChildProcess | undefined = undefined;

	if (launch.detached) {

		let forkedLauncherPath = path.join(__dirname, './launcher.bundle.js');
		let forkArgs: string[];
		switch (launch.tmpDirs.length) {
			case 0:
				forkArgs = [
					'spawnDetached', launch.waterfoxExecutable, ...launch.waterfoxArgs
				];
				break;

			case 1:
				forkArgs = [
					'forkDetached', forkedLauncherPath,
					'spawnAndRemove', launch.tmpDirs[0], launch.waterfoxExecutable, ...launch.waterfoxArgs
				];
				break;

			default:
				forkArgs = [
					'forkDetached', forkedLauncherPath,
					'spawnAndRemove2', launch.tmpDirs[0], launch.tmpDirs[1], launch.waterfoxExecutable, ...launch.waterfoxArgs
				];
				break;
		}

		fork(forkedLauncherPath, forkArgs, { env, execArgv: [] });

	} else {

		childProc = spawn(launch.waterfoxExecutable, launch.waterfoxArgs, { env, detached: true });

		childProc.stdout?.on('data', () => undefined);
		childProc.stderr?.on('data', () => undefined);

		childProc.unref();
	}

	return childProc;
}

export async function openNewTab(
	config: ParsedAttachConfiguration,
	description: WaterfoxDebugProtocol.DeviceDescription
): Promise<boolean> {

	if (!config.url) return true;

	let waterfoxExecutable = config.waterfoxExecutable;
	if (!waterfoxExecutable) {

		let waterfoxEdition: 'stable' | 'developer' | 'nightly' | undefined;
		if (description.channel === 'release') {
			waterfoxEdition = 'stable';
		} else if (description.channel === 'aurora') {
			waterfoxEdition = 'developer';
		} else if (description.channel === 'nightly') {
			waterfoxEdition = 'nightly';
		}

		if (waterfoxEdition) {
			const candidates = getExecutableCandidates(waterfoxEdition);
			for (let i = 0; i < candidates.length; i++) {
				if (await isExecutable(candidates[i])) {
					waterfoxExecutable = candidates[i];
					break;
				}
			}
		}

		if (!waterfoxExecutable) return false;
	}

	const waterfoxArgs = config.profileDir ? [ '--profile', config.profileDir ] : [ '-P', description.profile ];
	waterfoxArgs.push(config.url);

	spawn(waterfoxExecutable, waterfoxArgs);

	return true;
}

async function prepareDebugProfile(config: ParsedLaunchConfiguration): Promise<WaterfoxProfile> {

	var profile = await createDebugProfile(config);

	for (let key in config.preferences) {
		profile.setPreference(key, config.preferences[key]);
	}

	profile.updatePreferences();

	return profile;
}

function createDebugProfile(config: ParsedLaunchConfiguration): Promise<WaterfoxProfile> {
	return new Promise<WaterfoxProfile>(async (resolve, reject) => {

		if (config.srcProfileDir) {

			WaterfoxProfile.copy({
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
			let profile = new WaterfoxProfile({
				destinationDirectory: config.profileDir
			});
			profile.shouldDeleteOnExit(false);
			resolve(profile);
		}
	});
}
