import * as path from 'path';
import { ParsedAddonConfiguration } from '../configuration';
import { RootActorProxy } from '../waterfox/actorProxy/root';
import { AddonsActorProxy } from '../waterfox/actorProxy/addons';
import { PreferenceActorProxy } from '../waterfox/actorProxy/preference';
import { ConsoleActorProxy } from '../waterfox/actorProxy/console';
import { WebExtensionActorProxy } from '../waterfox/actorProxy/webExtension';
import { TabActorProxy } from '../waterfox/actorProxy/tab';
import { WaterfoxDebugSession } from '../waterfoxDebugSession';
import { PopupAutohideEventBody } from '../../common/customEvents';
import { isWindowsPlatform } from '../../common/util';

export const popupAutohidePreferenceKey = 'ui.popup.disable_autohide';

/**
 * When debugging a WebExtension, this class installs the WebExtension, attaches to it, reloads it
 * when desired and tells the [`PopupAutohideManager`](../../extension/popupAutohideManager.ts) the
 * initial state of the popup auto-hide flag by sending a custom event.
 */
export class AddonManager {

	private readonly config: ParsedAddonConfiguration;

	private addonAttached = false;
	private addonActor: TabActorProxy | undefined = undefined;

	constructor(
		private readonly enableCRAWorkaround: boolean,
		private readonly debugSession: WaterfoxDebugSession
	) {
		this.config = debugSession.config.addon!;
	}

	public async sessionStarted(
		rootActor: RootActorProxy,
		addonsActor: AddonsActorProxy,
		preferenceActor: PreferenceActorProxy,
		useConnect: boolean
	): Promise<void> {

		const addonPath = isWindowsPlatform() ? path.normalize(this.config.path) : this.config.path;
		let result = await addonsActor.installAddon(addonPath);
		if (!this.config.id) {
			this.config.id = result.addon.id;
		}

		this.fetchAddonsAndAttach(rootActor, useConnect);

		if (this.config.popupAutohideButton) {
			const popupAutohide = !(await preferenceActor.getBoolPref(popupAutohidePreferenceKey));
			this.debugSession.sendCustomEvent('popupAutohide', <PopupAutohideEventBody>{ popupAutohide });
		}
	}

	public async reloadAddon(): Promise<void> {
		if (!this.addonActor) {
			throw 'Addon isn\'t attached';
		}

		await this.addonActor.reload();
	}

	private async fetchAddonsAndAttach(rootActor: RootActorProxy, useConnect: boolean): Promise<void> {

		if (this.addonAttached) return;

		let addons = await rootActor.fetchAddons();

		if (this.addonAttached) return;

		addons.forEach((addon) => {
			if (addon.id === this.config.id) {
				(async () => {

					let consoleActor: ConsoleActorProxy;
					let webExtensionActor = new WebExtensionActorProxy(
						addon, this.enableCRAWorkaround, this.debugSession.pathMapper,
						this.debugSession.waterfoxDebugConnection);

					if (useConnect) {
						[this.addonActor, consoleActor] = await webExtensionActor.connect();
					} else {
						[this.addonActor, consoleActor] = await webExtensionActor.getTarget();
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
}
