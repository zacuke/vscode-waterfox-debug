import { ISourceActorProxy, BreakpointActorProxy } from '../firefox/index';
import { BreakpointInfo, VariablesProvider, VariableAdapter, ThreadAdapter } from './index';
import { Registry } from './registry';
import { Source } from 'vscode-debugadapter';
import { DebugProtocol } from 'vscode-debugprotocol';

let actorIdRegex = /[0-9]+$/;

export class SourceAdapter {

	public readonly id: number;
	public readonly source: Source;

	// this promise will resolve to the list of breakpoints set on this source
	private breakpointsPromise: Promise<BreakpointAdapter[]>;
	// the list of breakpoints set on this source, this may be set to undefined if any breakpoints
	// are in the process of being sent to Firefox, in this case use breakpointsPromise
	private currentBreakpoints?: BreakpointAdapter[];

	public constructor(
		sourceRegistry: Registry<SourceAdapter>,
		public actor: ISourceActorProxy,
		public readonly sourcePath: string | undefined
	) {
		this.id = sourceRegistry.register(this);
		this.breakpointsPromise = Promise.resolve([]);
		this.currentBreakpoints = [];
		this.source = SourceAdapter.createSource(actor, sourcePath, this.id);
	}

	private static createSource(
		actor: ISourceActorProxy,
		sourcePath: string | undefined,
		id: number
	): Source {

		let sourceName = '';
		if (actor.url != null) {
			sourceName = actor.url.split('/').pop()!.split('#')[0];
		} else if (actor.source.introductionType === 'eval') {
			let match = actorIdRegex.exec(actor.name);
			if (match) {
				sourceName = `eval ${match[0]}`;
			}
		}

		let source: Source;
		if (sourcePath !== undefined) {
			source = new Source(sourceName, sourcePath);
		} else {
			source = new Source(sourceName, actor.url || undefined, id);
		}

		if (actor.source.isBlackBoxed) {
			(<DebugProtocol.Source>source).presentationHint = 'deemphasize';
		}

		return source;
	}

	public getBreakpointsPromise(): Promise<BreakpointAdapter[]> {
		return this.breakpointsPromise;
	}

	public hasCurrentBreakpoints(): boolean {
		return this.currentBreakpoints !== undefined;
	}

	public getCurrentBreakpoints(): BreakpointAdapter[] | undefined {
		return this.currentBreakpoints;
	}

	public setBreakpointsPromise(promise: Promise<BreakpointAdapter[]>) {
		this.breakpointsPromise = promise;
		this.currentBreakpoints = undefined;
		this.breakpointsPromise.then((breakpoints) => this.currentBreakpoints = breakpoints);
	}

	public dispose(): void {
		this.actor.dispose();
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
	public readonly threadLifetime = true;
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
