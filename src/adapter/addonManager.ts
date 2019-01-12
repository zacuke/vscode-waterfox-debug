import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs-extra';
import * as uuid from 'uuid';
import { execSync } from 'child_process';
import * as semver from 'semver';
import { AddonType, ParsedAddonConfiguration } from '../configuration';
import FirefoxProfile = require('firefox-profile');
import * as zipdir from 'zip-dir';
import { Extract } from 'unzipper';
import { RootActorProxy, AddonsActorProxy, PreferenceActorProxy, ConsoleActorProxy, WebExtensionActorProxy, TabActorProxy } from "../firefox/index";
import { FirefoxDebugSession } from "../firefoxDebugSession";
import { PopupAutohideEventBody } from '../extension/customEvents';

export const popupAutohidePreferenceKey = 'ui.popup.disable_autohide';

export class AddonManager {

	private readonly config: ParsedAddonConfiguration;

	private addonBuildPath?: string;
	private addonAttached = false;
	private addonActor: TabActorProxy | undefined = undefined;

	constructor(
		private readonly debugSession: FirefoxDebugSession
	) {
		this.config = debugSession.config.addon!;
	}

	public async profilePrepared(profile: FirefoxProfile): Promise<void> {

		if (this.config.installInProfile) {

			let tempXpiDir = path.join(os.tmpdir(), `vscode-firefox-debug-${uuid.v4()}`);
			await fs.mkdir(tempXpiDir);
			let tempXpiPath = await this.createXpi(this.config.type, this.config.path, tempXpiDir);

			await new Promise<void>((resolve, reject) => {
				profile.addExtension(tempXpiPath, async (err, addonDetails) => {
					await fs.remove(tempXpiDir);
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
		addonsActor: AddonsActorProxy | undefined,
		preferenceActor: PreferenceActorProxy,
		debugSession: FirefoxDebugSession
	): Promise<void> {

		switch (this.config.type) {

			case 'legacy':
				if (addonsActor && !this.config.installInProfile) {
					await addonsActor.installAddon(this.config.path);
				}

				let [addonActor, consoleActor] = await rootActor.fetchProcess();
				let tabId = debugSession.tabs.register(addonActor);
				debugSession.attachTabOrAddon(addonActor, consoleActor, 'Browser', tabId);

				break;

			case 'addonSdk':
				if (addonsActor && !this.config.installInProfile) {

					if (this.addonBuildPath) {
						await this.buildAddonDir(this.config.path, this.addonBuildPath);
						await addonsActor.installAddon(this.addonBuildPath);
						await preferenceActor.setCharPref('vscode.debug.temporaryAddonPath', this.addonBuildPath);
					} else {
						try {
							this.addonBuildPath = await preferenceActor.getCharPref('vscode.debug.temporaryAddonPath');
							await fs.copy(this.config.path, this.addonBuildPath);
						} catch (err) {
						}
					}
				}

				this.fetchAddonsAndAttach(rootActor);

				break;

			case 'webExtension':
				if (addonsActor && !this.config.installInProfile) {
					let result = await addonsActor.installAddon(this.config.path);
					if (!this.config.id) {
						this.config.id = result.addon.id;
					}
				}

				this.fetchAddonsAndAttach(rootActor);

				break;
		}

		if (this.config.popupAutohideButton) {
			const popupAutohide = !(await preferenceActor.getBoolPref(popupAutohidePreferenceKey));
			debugSession.sendCustomEvent('popupAutohide', <PopupAutohideEventBody>{ popupAutohide });
		}
	}

	public async reloadAddon(): Promise<void> {
		if (!this.addonActor) {
			throw 'Addon isn\'t attached';
		}

		if (this.addonBuildPath) {
			await fs.copy(this.config.path, this.addonBuildPath);
		}

		await this.addonActor.reload();
	}

	public async rebuildAddon(): Promise<void> {
		if (!this.addonBuildPath) {
			throw 'This command is only available when debugging an addon of type "addonSdk"';
		}

		await this.buildAddonDir(this.config.path, this.addonBuildPath);
	}

	private async fetchAddonsAndAttach(rootActor: RootActorProxy): Promise<void> {

		if (this.addonAttached) return;

		let addons = await rootActor.fetchAddons();

		if (this.addonAttached) return;

		const sourceMaps = this.debugSession.config.sourceMaps;

		addons.forEach((addon) => {
			if (addon.id === this.config.id) {
				(async () => {

					let consoleActor: ConsoleActorProxy;
					if (addon.isWebExtension) {

						let webExtensionActor = new WebExtensionActorProxy(
							addon, sourceMaps, this.debugSession.pathMapper,
							this.debugSession.firefoxDebugConnection);
						[this.addonActor, consoleActor] = await webExtensionActor.connect();

					} else {

						this.addonActor = new TabActorProxy(
							addon.actor, addon.name, '', sourceMaps, this.debugSession.pathMapper,
							this.debugSession.firefoxDebugConnection);
						consoleActor = new ConsoleActorProxy(
							addon.consoleActor!, this.debugSession.firefoxDebugConnection);
					}

					let threadAdapter = await this.debugSession.attachTabOrAddon(
						this.addonActor, consoleActor, 'Addon');
					if (threadAdapter !== undefined) {
						this.debugSession.attachConsole(consoleActor, threadAdapter);
					}
					this.addonAttached = true;
				})();
			}
		});
	}

	private createXpi(addonType: AddonType, addonPath: string, destDir: string): Promise<string> {
		return new Promise<string>(async (resolve, reject) => {

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
						resolve(path.join(destDir, (await fs.readdir(destDir))[0]));

					} catch (err) {
						reject(`Couldn't run jpm: ${err.stderr}`);
					}
					break;
			}
		});
	}

	private async buildAddonDir(addonPath: string, destDir: string): Promise<void> {
		await fs.mkdir(destDir);
		let xpiPath = await this.createXpi('addonSdk', addonPath, destDir);
		await this.unzip(xpiPath, destDir);
		await fs.unlink(xpiPath);
	}

	private unzip(srcFile: string, destDir: string): Promise<void> {
		return new Promise<void>((resolve, reject) => {
			let extractor = Extract({ path: destDir });
			extractor.on('close', resolve);
			extractor.on('error', reject);
			fs.createReadStream(srcFile).pipe(extractor);
		});
	}
}
