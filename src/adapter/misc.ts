import { BreakpointActorProxy } from '../firefox/index';
import { VariablesProvider, VariableAdapter, ThreadAdapter } from './index';
import { DebugProtocol } from 'vscode-debugprotocol';

export class BreakpointInfo {

	public actualLine: number | undefined;
	public actualColumn: number | undefined;
	public verified: boolean;

	public constructor(
		public readonly id: number,
		public readonly requestedBreakpoint: DebugProtocol.SourceBreakpoint
	) {
		this.verified = false;
	}

	public isEquivalent(other: BreakpointInfo | DebugProtocol.SourceBreakpoint): boolean {

		const bp1 = this.requestedBreakpoint;
		const bp2 = (other instanceof BreakpointInfo) ? other.requestedBreakpoint : other;

		return (bp1.line === bp2.line) && (bp1.column === bp2.column) && (bp1.condition === bp2.condition);
	}
}

export class BreakpointAdapter {
	
	public breakpointInfo: BreakpointInfo;
	public actor: BreakpointActorProxy;
	
	public constructor(requestedBreakpoint: BreakpointInfo, actor: BreakpointActorProxy) {
		this.breakpointInfo = requestedBreakpoint;
		this.actor = actor;
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
