import { BreakpointActorProxy } from '../firefox/actorProxy/breakpoint';
import { SourceAdapter } from './source';
import { DebugProtocol } from 'vscode-debugprotocol';

export class BreakpointInfo {

	/**
	 * the actual line where the breakpoint was set (which may be different from the requested line
	 * in `requestedBreakpoint.line`)
	 */
	public actualLine: number | undefined;

	/**
	 * the actual column where the breakpoint was set (which may be different from the requested
	 * column in `requestedBreakpoint.column`)
	 */
	public actualColumn: number | undefined;

	/** true if the breakpoint was successfully set */
	public verified: boolean;

	/** how many times the breakpoint should be skipped initially */
	public readonly hitCount: number;

	public constructor(
		public readonly id: number,
		public readonly requestedBreakpoint: DebugProtocol.SourceBreakpoint
	) {
		this.verified = false;
		this.hitCount = parseInt(requestedBreakpoint.hitCondition || '') || 0;
	}

	public isEquivalent(other: BreakpointInfo | DebugProtocol.SourceBreakpoint): boolean {

		const bp1 = this.requestedBreakpoint;
		const bp2 = (other instanceof BreakpointInfo) ? other.requestedBreakpoint : other;

		return (bp1.line === bp2.line) && (bp1.column === bp2.column) &&
			(bp1.condition === bp2.condition) && (bp1.logMessage === bp2.logMessage);
	}
}

export interface BreakpointAdapter {
	readonly breakpointInfo: BreakpointInfo;
	readonly actorName: string | undefined;
	hitCount: number;
	delete(): Promise<void>;
}

/**
 * Adapter class for a breakpoint in Firefox < 67
 */
export class OldProtocolBreakpointAdapter implements BreakpointAdapter {

	public hitCount: number;

	public get actorName(): string {
		return this.actor.name;
	}

	public constructor(
		public readonly breakpointInfo: BreakpointInfo,
		private readonly actor: BreakpointActorProxy
	) {
		this.hitCount = 0;
	}

	delete(): Promise<void> {
		return this.actor.delete();
	}
}

/**
 * Adapter class for a breakpoint in Firefox >= 67
 */
export class NewProtocolBreakpointAdapter implements BreakpointAdapter {

	public hitCount: number;

	public get actorName(): undefined {
		return undefined;
	}

	public constructor(
		public readonly breakpointInfo: BreakpointInfo,
		private readonly sourceAdapter: SourceAdapter
	) {
		this.hitCount = 0;
	}

	delete(): Promise<void> {
		return this.sourceAdapter.threadAdapter.actor.removeBreakpoint(
			this.breakpointInfo.actualLine!,
			this.breakpointInfo.actualColumn!,
			this.sourceAdapter.actor.url!
		);
	}
}
