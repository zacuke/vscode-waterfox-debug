import { ThreadAdapter, Registry } from "./index";

export class SkipFilesManager {

	private dynamicFiles = new Map<string, boolean>();

	public constructor(
		private readonly configuredFilesToSkip: RegExp[],
		private readonly threads: Registry<ThreadAdapter>
	) {}

	public shouldSkip(path: string): boolean {

		if (this.dynamicFiles.has(path)) {
			return this.dynamicFiles.get(path)!;
		}

		for (let regExp of this.configuredFilesToSkip) {
			if (regExp.test(path)) {
				return true;
			}
		}

		return false;
	}

	public toggleSkipping(path: string) {
		
		const skipFile = !this.shouldSkip(path);
		this.dynamicFiles.set(path, skipFile);

		for (const [, thread] of this.threads) {

			let sourceAdapters = thread.findSourceAdaptersForPath(path, true);

			for (const sourceAdapter of sourceAdapters) {
				if (sourceAdapter.actor.source.isBlackBoxed !== skipFile) {
					sourceAdapter.actor.setBlackbox(skipFile);
				}
			}
		}
	}
}
