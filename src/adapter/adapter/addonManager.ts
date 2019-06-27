import { ParsedAddonConfiguration } from '../configuration';
import { RootActorProxy, AddonsActorProxy, PreferenceActorProxy, ConsoleActorProxy, WebExtensionActorProxy, TabActorProxy } from '../firefox/index';
import { FirefoxDebugSession } from '../firefoxDebugSession';
import { PopupAutohideEventBody } from '../../common/customEvents';

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
		private readonly debugSession: FirefoxDebugSession
	) {
		this.config = debugSession.config.addon!;
	}

	public async sessionStarted(
		rootActor: RootActorProxy,
		addonsActor: AddonsActorProxy,
		preferenceActor: PreferenceActorProxy,
		debugSession: FirefoxDebugSession
	): Promise<void> {

		let result = await addonsActor.installAddon(this.config.path);
		if (!this.config.id) {
			this.config.id = result.addon.id;
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
					let webExtensionActor = new WebExtensionActorProxy(
						addon, sourceMaps, this.debugSession.pathMapper,
						this.debugSession.firefoxDebugConnection);
					[this.addonActor, consoleActor] = await webExtensionActor.connect();

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
