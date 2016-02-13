import { SourceActorProxy, BreakpointActorProxy } from '../firefox/index';
import { DebugProtocol } from 'vscode-debugprotocol';

export class SourceAdapter {
	
	public id: number;
	public actor: SourceActorProxy;
	public currentBreakpoints: Promise<BreakpointAdapter[]>;
	
	public constructor(id: number, actor: SourceActorProxy) {
		this.id = id;
		this.actor = actor;
		this.currentBreakpoints = Promise.resolve([]);
	}
}

export class BreakpointAdapter {
	
	public requestedBreakpoint: DebugProtocol.SourceBreakpoint;
	public actualLine: number;
	public actor: BreakpointActorProxy;
	
	public constructor(requestedBreakpoint: DebugProtocol.SourceBreakpoint, actualLine: number, actor: BreakpointActorProxy) {
		this.requestedBreakpoint = requestedBreakpoint;
		this.actualLine = actualLine;
		this.actor = actor;
	}
}

