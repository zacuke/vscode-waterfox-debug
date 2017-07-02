import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs-extra';
import * as uuid from 'uuid';
import { execSync } from 'child_process';
import * as semver from 'semver';
import { AddonType, ParsedAddonConfiguration } from '../configuration';
import * as FirefoxProfile from 'firefox-profile';
import * as zipdir from 'zip-dir';
import { Extract } from 'unzip';
import { RootActorProxy, AddonsActorProxy, PreferenceActorProxy, ConsoleActorProxy, WebExtensionActorProxy, TabActorProxy } from "../firefox/index";
import { FirefoxDebugAdapter } from "../firefoxDebugAdapter";

export class AddonManager {

	private addonBuildPath?: string;
	private addonAttached = false;
	private addonActor: TabActorProxy | undefined = undefined;

	constructor(
		private readonly config: ParsedAddonConfiguration,
		private readonly sourceMaps: 'client' | 'server'
	) {}

	public async profilePrepared(profile: FirefoxProfile): Promise<void> {

		if (this.config.installInProfile) {

			let tempXpiDir = path.join(os.tmpdir(), `vscode-firefox-debug-${uuid.v4()}`);
			fs.mkdirSync(tempXpiDir);
			let tempXpiPath = await createXpi(this.config.type, this.config.path, tempXpiDir);

			await new Promise<void>((resolve, reject) => {
				profile.addExtension(tempXpiPath, (err, addonDetails) => {
					fs.removeSync(tempXpiDir);
					if (err) {
						reject(err);
					} else {
						resolve();
					}
				})
			});

		} else if (this.config.type === 'addonSdk') {
			this.addonBuildPath = path.join(os.tmpdir(), `vscode-firefox-debug-addon-${uuid.v4()}`);
		}
	}

	public async sessionStarted(
		rootActor: RootActorProxy,
		addonsActor: AddonsActorProxy,
		preferenceActor: PreferenceActorProxy,
		debugAdapter: FirefoxDebugAdapter
	): Promise<void> {

		switch (this.config.type) {

			case 'legacy':
				if (!this.config.installInProfile) {
					await addonsActor.installAddon(this.config.path);
				}

				let [addonActor, consoleActor] = await rootActor.fetchProcess();
				let tabId = debugAdapter.tabs.register(addonActor);
				debugAdapter.attachTabOrAddon(addonActor, consoleActor, 'Browser', tabId);

				break;

			case 'addonSdk':
				if (!this.config.installInProfile) {

					if (this.addonBuildPath) {
						await buildAddonDir(this.config.path, this.addonBuildPath);
						await addonsActor.installAddon(this.addonBuildPath);
						await preferenceActor.setCharPref('vscode.debug.temporaryAddonPath', this.addonBuildPath);
					} else {
						try {
							this.addonBuildPath = await preferenceActor.getCharPref('vscode.debug.temporaryAddonPath');
							fs.copySync(this.config.path, this.addonBuildPath);
						} catch (err) {
						}
					}
				}

				this.fetchAddonsAndAttach(rootActor, debugAdapter);

				break;

			case 'webExtension':
				if (!this.config.installInProfile) {
					await addonsActor.installAddon(this.config.path);
				}

				this.fetchAddonsAndAttach(rootActor, debugAdapter);

				break;
		}
	}

	public async reloadAddon(): Promise<void> {
		if (!this.addonActor) {
			throw 'Addon isn\'t attached';
		}

		if (this.addonBuildPath) {
			fs.copySync(this.config.path, this.addonBuildPath);
		}

		await this.addonActor.reload();
	}

	public async rebuildAddon(): Promise<void> {
		if (!this.addonBuildPath) {
			throw 'This command is only available when debugging an addon of type "addonSdk"';
		}

		await buildAddonDir(this.config.path, this.addonBuildPath);
	}

	//TODO private readonly debugAdapter ?
	private async fetchAddonsAndAttach(rootActor: RootActorProxy, debugAdapter: FirefoxDebugAdapter): Promise<void> {

		if (this.addonAttached) return;

		let addons = await rootActor.fetchAddons();

		if (this.addonAttached) return;

		addons.forEach((addon) => {
			if (addon.id === this.config.id) {
				(async () => {

					let consoleActor: ConsoleActorProxy;
					if (addon.isWebExtension) {

						let webExtensionActor = new WebExtensionActorProxy(
							addon, this.sourceMaps, debugAdapter.firefoxDebugConnection);
						[this.addonActor, consoleActor] = await webExtensionActor.connect();

					} else {

						this.addonActor = new TabActorProxy(
							addon.actor, addon.name, '', this.sourceMaps, debugAdapter.firefoxDebugConnection);
						consoleActor = new ConsoleActorProxy(
							addon.consoleActor!, debugAdapter.firefoxDebugConnection);
					}

					let threadAdapter = await debugAdapter.attachTabOrAddon(
						this.addonActor, consoleActor, 'Addon');
					if (threadAdapter !== undefined) {
						debugAdapter.attachConsole(consoleActor, threadAdapter);
					}
					this.addonAttached = true;
				})();
			}
		});
	}
}

export function createXpi(addonType: AddonType, addonPath: string, destDir: string): Promise<string> {
	return new Promise<string>((resolve, reject) => {

		switch (addonType) {

			case 'legacy':
			case 'webExtension':
				let destFile = path.join(destDir, 'addon.xpi');
				zipdir(addonPath, { saveTo: destFile },
				(err, buffer) => {
					if (err) {
						reject(err);
					} else {
						resolve(destFile);
					}
				});
				break;

			case 'addonSdk':
				try {
					let jpmVersion = execSync('jpm -V', { encoding: 'utf8' });
					jpmVersion = (<string>jpmVersion).trim();
					if (semver.lt(jpmVersion, '1.2.0')) {
						reject(`Please install a newer version of jpm (You have ${jpmVersion}, but 1.2.0 or newer is required)`);
						return;
					}

					execSync(`jpm xpi --dest-dir "${destDir}"`, { cwd: addonPath });
					resolve(path.join(destDir, fs.readdirSync(destDir)[0]));

				} catch (err) {
					reject(`Couldn't run jpm: ${err.stderr}`);
				}
				break;
		}
	});
}

async function buildAddonDir(addonPath: string, destDir: string): Promise<void> {
	fs.mkdirSync(destDir);
	let xpiPath = await createXpi('addonSdk', addonPath, destDir);
	await unzip(xpiPath, destDir);
	fs.unlinkSync(xpiPath);
}

export function findAddonId(addonPath: string): Promise<string> {
	return new Promise<string>((resolve, reject) => {
		var dummyProfile = new FirefoxProfile();
		(<any>dummyProfile)._addonDetails(addonPath, (addonDetails: { id?: string | null }) => {
			if (typeof addonDetails.id === 'string') {
				resolve(addonDetails.id);
			} else {
				reject('This debugger currently requires add-ons to specify an ID in their manifest');
			}
		});
	});
}

function unzip(srcFile: string, destDir: string): Promise<void> {
	return new Promise<void>((resolve, reject) => {
		let extractor = Extract({ path: destDir });
		extractor.on('close', resolve);
		extractor.on('error', reject);
		fs.createReadStream(srcFile).pipe(extractor);
	});
}
