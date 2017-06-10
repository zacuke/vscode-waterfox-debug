import { ISourceActorProxy, BreakpointActorProxy } from '../firefox/index';
import { BreakpointInfo, VariablesProvider, VariableAdapter, ThreadAdapter } from './index';

export class SourceAdapter {
	
	public id: number;
	public actor: ISourceActorProxy;
	public sourcePath?: string;
	// this promise will resolve to the list of breakpoints set on this source
	private breakpointsPromise: Promise<BreakpointAdapter[]>;
	// the list of breakpoints set on this source, this may be set to undefined if any breakpoints
	// are in the process of being sent to Firefox, in this case use breakpointsPromise
	private currentBreakpoints?: BreakpointAdapter[];

	public constructor(id: number, actor: ISourceActorProxy, sourcePath?: string) {
		this.id = id;
		this.actor = actor;
		this.sourcePath = sourcePath;
		this.breakpointsPromise = Promise.resolve([]);
		this.currentBreakpoints = [];
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

	public constructor(private variables: VariableAdapter[], public threadAdapter: ThreadAdapter) {
		this.variablesProviderId = threadAdapter.debugSession.registerVariablesProvider(this);
	}

	public getVariables(): Promise<VariableAdapter[]> {
		return Promise.resolve(this.variables);
	}
}
