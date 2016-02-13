import { Log } from '../util/log';
import { ThreadActorProxy, SourceActorProxy, BreakpointActorProxy } from '../firefox/index';
import { ObjectReferencesAdapter } from '../adapter/index';
import { FirefoxDebugSession } from '../firefoxDebugSession';
import { DebugProtocol } from 'vscode-debugprotocol';
import { Source, StackFrame } from 'vscode-debugadapter';

export class ThreadAdapter {
	
	public id: number;
	public actor: ThreadActorProxy;
	public sources: SourceAdapter[];

	private objectReferences: ObjectReferencesAdapter;
	
	public constructor(id: number, actor: ThreadActorProxy, debugSession: FirefoxDebugSession) {
		this.id = id;
		this.actor = actor;
		this.sources = [];
		this.objectReferences = new ObjectReferencesAdapter(id, actor, debugSession);
	}
	
	public fetchStackFrames(): Promise<FirefoxDebugProtocol.Frame[]> {
		return this.objectReferences.fetchStackFrames();
	}
	
	public evaluate(expression: string, isWatch: boolean): Promise<FirefoxDebugProtocol.Grip> {
		return this.objectReferences.evaluate(expression, isWatch);
	}
}

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

