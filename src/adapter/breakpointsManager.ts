import { Log } from '../util/log';
import { SourceAdapter, ThreadAdapter, Registry, BreakpointInfo } from './index';
import { DebugProtocol } from 'vscode-debugprotocol';
import { Breakpoint, BreakpointEvent } from 'vscode-debugadapter';

let log = Log.create('BreakpointsAdapter');

export class BreakpointsManager {

	private nextBreakpointId = 1;
	private readonly breakpointsBySourcePathOrUrl = new Map<string, BreakpointInfo[]>();

	constructor(
		private readonly threads: Registry<ThreadAdapter>,
		private readonly sendEvent: (ev: DebugProtocol.Event) => void
	) {}

	public setBreakpoints(
		breakpoints: DebugProtocol.SourceBreakpoint[],
		sourcePathOrUrl: string
	): BreakpointInfo[] {

		log.debug(`Setting ${breakpoints.length} breakpoints for ${sourcePathOrUrl}`);

		const oldBreakpointInfos = this.breakpointsBySourcePathOrUrl.get(sourcePathOrUrl);
		const breakpointInfos = breakpoints.map(
			breakpoint => this.getOrCreateBreakpointInfo(breakpoint, oldBreakpointInfos)
		);

		this.breakpointsBySourcePathOrUrl.set(sourcePathOrUrl, breakpointInfos);

		for (const [, threadAdapter] of this.threads) {
			const sourceAdapters = threadAdapter.findSourceAdaptersForPathOrUrl(sourcePathOrUrl);
			for (const sourceAdapter of sourceAdapters) {
				sourceAdapter.updateBreakpoints(breakpointInfos);
			}
		}

		return breakpointInfos;
	}

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

	public onNewSource(sourceAdapter: SourceAdapter) {
		const sourcePath = sourceAdapter.sourcePath;
		if (sourcePath !== undefined) {
			const breakpointInfos = this.breakpointsBySourcePathOrUrl.get(sourcePath);
			if (breakpointInfos !== undefined) {
				sourceAdapter.updateBreakpoints(breakpointInfos);
			}
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
