import { Log } from '../util/log';
import { isWindowsPlatform as detectWindowsPlatform } from '../../common/util';
import { ThreadAdapter, Registry } from './index';

let log = Log.create('SkipFilesManager');

/**
 * This class determines which files should be skipped (aka blackboxed). Files to be skipped are
 * configured using the `skipFiles` configuration property or by using the context menu on a
 * stackframe in VS Code.
 */
export class SkipFilesManager {

	private readonly isWindowsPlatform = detectWindowsPlatform();

	/**
	 * Files that were configured to (not) be skipped by using the context menu on a
	 * stackframe in VS Code. This overrides the `skipFiles` configuration property.
	 */
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

	public toggleSkippingPath(path: string): Promise<void> {
		return this.toggleSkipping(path, true);
	}

	public toggleSkippingUrl(url: string): Promise<void> {
		return this.toggleSkipping(url, false);
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

	private async toggleSkipping(pathOrUrl: string, isPath: boolean): Promise<void> {
		
		const skipFile = !this.shouldSkip(pathOrUrl, isPath);
		this.dynamicFiles.set(pathOrUrl, skipFile);

		log.info(`Setting skipFile to ${skipFile} for ${pathOrUrl}`);

		let promises: Promise<void>[] = [];

		for (const [, thread] of this.threads) {

			let sourceAdapters = thread.findSourceAdaptersForPathOrUrl(pathOrUrl);

			for (const sourceAdapter of sourceAdapters) {
				if (sourceAdapter.actor.source.isBlackBoxed !== skipFile) {
					promises.push(sourceAdapter.actor.setBlackbox(skipFile));
				}
			}

			thread.triggerStackframeRefresh();
		}

		await Promise.all(promises);
	}
}
