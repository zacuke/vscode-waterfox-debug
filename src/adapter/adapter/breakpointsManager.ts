import { Log } from '../util/log';
import { isWindowsPlatform as detectWindowsPlatform } from '../../common/util';
import { SourceAdapter, ThreadAdapter, Registry, BreakpointInfo } from './index';
import { DebugProtocol } from 'vscode-debugprotocol';
import { Breakpoint, BreakpointEvent } from 'vscode-debugadapter';

let log = Log.create('BreakpointsManager');

const isWindowsPlatform = detectWindowsPlatform();
const windowsAbsolutePathRegEx = /^[a-zA-Z]:\\/;

/**
 * This class holds all breakpoints that have been set in VS Code and synchronizes them with all
 * sources in all threads in Firefox using [`SourceAdapter#updateBreakpoints()`](./source.ts).
 */
export class BreakpointsManager {

	private nextBreakpointId = 1;
	private readonly breakpointsBySourcePathOrUrl = new Map<string, BreakpointInfo[]>();

	constructor(
		private readonly threads: Registry<ThreadAdapter>,
		private readonly sendEvent: (ev: DebugProtocol.Event) => void
	) {}

	/**
	 * called by [`FirefoxDebugAdapter#setBreakpoints()`](../firefoxDebugAdapter.ts) whenever the
	 * breakpoints have been changed by the user in VS Code
	 */
	public setBreakpoints(
		breakpoints: DebugProtocol.SourceBreakpoint[],
		sourcePathOrUrl: string
	): BreakpointInfo[] {

		log.debug(`Setting ${breakpoints.length} breakpoints for ${sourcePathOrUrl}`);

		const key = this.createBreakpointInfoKey(sourcePathOrUrl);
		const oldBreakpointInfos = this.breakpointsBySourcePathOrUrl.get(key);
		const breakpointInfos = breakpoints.map(
			breakpoint => this.getOrCreateBreakpointInfo(breakpoint, oldBreakpointInfos)
		);

		this.breakpointsBySourcePathOrUrl.set(key, breakpointInfos);

		for (const [, threadAdapter] of this.threads) {
			const sourceAdapters = threadAdapter.findSourceAdaptersForPathOrUrl(sourcePathOrUrl);
			for (const sourceAdapter of sourceAdapters) {
				sourceAdapter.updateBreakpoints(breakpointInfos);
			}
		}

		return breakpointInfos;
	}

	/** 
	 * called by [`SourceAdapter#syncBreakpoints()`](./source.ts) whenever a breakpoint has been set
	 * in Firefox
	 */
	public verifyBreakpoint(
		breakpointInfo: BreakpointInfo,
		actualLine: number | undefined,
		actualColumn: number | undefined
	): void {

		if ((breakpointInfo.actualLine !== actualLine) ||
			(breakpointInfo.actualColumn !== actualColumn) ||
			!breakpointInfo.verified
		) {
			let breakpoint: DebugProtocol.Breakpoint = new Breakpoint(true, actualLine, actualColumn);
			breakpoint.id = breakpointInfo.id;
			this.sendEvent(new BreakpointEvent('changed', breakpoint));

			breakpointInfo.actualLine = actualLine;
			breakpointInfo.actualColumn = actualColumn;
			breakpointInfo.verified = true;
		}
	}

	/**
	 * called by [`FirefoxDebugSession#attachSource()`](../firefoxDebugSession.ts) whenever a new
	 * javascript source was attached
	 */
	public onNewSource(sourceAdapter: SourceAdapter) {
		const sourcePath = sourceAdapter.sourcePath;
		if (sourcePath !== undefined) {
			const key = this.createBreakpointInfoKey(sourcePath);
			const breakpointInfos = this.breakpointsBySourcePathOrUrl.get(key);
			if (breakpointInfos !== undefined) {
				sourceAdapter.updateBreakpoints(breakpointInfos);
			}
		}
	}

	private createBreakpointInfoKey(sourcePathOrUrl: string): string {
		if (isWindowsPlatform && windowsAbsolutePathRegEx.test(sourcePathOrUrl)) {
			return sourcePathOrUrl.toLowerCase();
		} else {
			return sourcePathOrUrl;
		}
	}

	private getOrCreateBreakpointInfo(
		requestedBreakpoint: DebugProtocol.SourceBreakpoint,
		oldBreakpointInfos: BreakpointInfo[] | undefined
	): BreakpointInfo {

		if (oldBreakpointInfos) {

			const oldBreakpointInfo = oldBreakpointInfos.find(
				breakpointInfo => breakpointInfo.isEquivalent(requestedBreakpoint)
			);

			if (oldBreakpointInfo) {
				return oldBreakpointInfo;
			}
		}

		return new BreakpointInfo(this.nextBreakpointId++, requestedBreakpoint);
	}
}
