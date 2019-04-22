import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs-extra';
import * as uuid from 'uuid';
import { ParsedAddonConfiguration } from '../configuration';
import FirefoxProfile from 'firefox-profile';
import zipdir from 'zip-dir';
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
			let tempXpiPath = await this.createXpi(this.config.path, tempXpiDir);

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
		}
	}

	public async sessionStarted(
		rootActor: RootActorProxy,
		addonsActor: AddonsActorProxy | undefined,
		preferenceActor: PreferenceActorProxy,
		debugSession: FirefoxDebugSession
	): Promise<void> {

		if (addonsActor && !this.config.installInProfile) {
			let result = await addonsActor.installAddon(this.config.path);
			if (!this.config.id) {
				this.config.id = result.addon.id;
			}
		}

		this.fetchAddonsAndAttach(rootActor);

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

	private createXpi(addonPath: string, destDir: string): Promise<string> {
		return new Promise<string>(async (resolve, reject) => {
			let destFile = path.join(destDir, 'addon.xpi');
			zipdir(addonPath, { saveTo: destFile }, (err, buffer) => {
				if (err) {
					reject(err);
				} else {
					resolve(destFile);
				}
			});
		});
	}
}
