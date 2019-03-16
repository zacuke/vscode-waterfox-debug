import { BreakpointActorProxy } from '../firefox/index';
import { VariablesProvider, VariableAdapter, ThreadAdapter, SourceAdapter } from './index';
import { DebugProtocol } from 'vscode-debugprotocol';

export class BreakpointInfo {

	public actualLine: number | undefined;
	public actualColumn: number | undefined;
	public verified: boolean;
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

		return (bp1.line === bp2.line) && (bp1.column === bp2.column) && (bp1.condition === bp2.condition);
	}
}

export interface BreakpointAdapter {
	readonly breakpointInfo: BreakpointInfo;
	readonly actorName: string | undefined;
	hitCount: number;
	delete(): Promise<void>;
}

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

export class ConsoleAPICallAdapter implements VariablesProvider {

	public readonly variablesProviderId: number;
	public readonly referenceExpression = undefined;
	public readonly referenceFrame = undefined;

	public constructor(
		private readonly variables: VariableAdapter[],
		public readonly threadAdapter: ThreadAdapter
	) {
		this.variablesProviderId = threadAdapter.debugSession.variablesProviders.register(this);
	}

	public getVariables(): Promise<VariableAdapter[]> {
		return Promise.resolve(this.variables);
	}
}
