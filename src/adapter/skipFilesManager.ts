import { Log } from '../util/log';
import { isWindowsPlatform as detectWindowsPlatform } from '../util/misc';
import { ThreadAdapter, Registry } from "./index";

let log = Log.create('SkipFilesManager');

export class SkipFilesManager {

	private readonly isWindowsPlatform = detectWindowsPlatform();
	private readonly dynamicFiles = new Map<string, boolean>();

	public constructor(
		private readonly configuredFilesToSkip: RegExp[],
		private readonly threads: Registry<ThreadAdapter>
	) {}

	public shouldSkipPath(path: string): boolean {
		return this.shouldSkip(path, true);
	}

	public shouldSkipUrl(url: string): boolean {
		return this.shouldSkip(url, false);
	}

	public toggleSkippingPath(path: string): void {
		this.toggleSkipping(path, true);
	}

	public toggleSkippingUrl(url: string): void {
		this.toggleSkipping(url, false);
	}

	private shouldSkip(pathOrUrl: string, isPath: boolean): boolean {

		if (this.dynamicFiles.has(pathOrUrl)) {

			let result = this.dynamicFiles.get(pathOrUrl)!;

			if (log.isDebugEnabled) {
				log.debug(`skipFile is set dynamically to ${result} for ${pathOrUrl}`);
			}

			return result;
		}

		let testee = pathOrUrl;
		if (isPath && this.isWindowsPlatform) {
			testee = testee.replace(/\\/g, '/');
		}
		for (let regExp of this.configuredFilesToSkip) {

			if (regExp.test(testee)) {

				if (log.isDebugEnabled) {
					log.debug(`skipFile is set per configuration to true for ${pathOrUrl}`);
				}

				return true;
			}
		}

		if (log.isDebugEnabled) {
			log.debug(`skipFile is not set for ${pathOrUrl}`);
		}

		return false;
	}

	private toggleSkipping(pathOrUrl: string, isPath: boolean): void {
		
		const skipFile = !this.shouldSkip(pathOrUrl, isPath);
		this.dynamicFiles.set(pathOrUrl, skipFile);

		log.info(`Setting skipFile to ${skipFile} for ${pathOrUrl}`);

		for (const [, thread] of this.threads) {

			let sourceAdapters = thread.findSourceAdaptersForPath(pathOrUrl, true);

			for (const sourceAdapter of sourceAdapters) {
				if (sourceAdapter.actor.source.isBlackBoxed !== skipFile) {
					sourceAdapter.actor.setBlackbox(skipFile);
				}
			}

			thread.triggerStackframeRefresh();
		}
	}
}
