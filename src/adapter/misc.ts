import { Log } from '../util/log';
import { ThreadActorProxy, SourceActorProxy, BreakpointActorProxy } from '../firefox/index';
import { ObjectReferencesAdapter } from '../adapter/index';
import { FirefoxDebugSession } from '../firefoxDebugSession';
import { Source, StackFrame } from 'vscode-debugadapter';

export class ThreadAdapter {
	public id: number;
	public actor: ThreadActorProxy;
	public objectReferences: ObjectReferencesAdapter;
	public sources: SourceAdapter[];
	
	public constructor(id: number, actor: ThreadActorProxy, debugSession: FirefoxDebugSession) {
		this.id = id;
		this.actor = actor;
		this.objectReferences = new ObjectReferencesAdapter(id, actor, debugSession);
		this.sources = [];
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
	public requestedLine: number;
	public actualLine: number;
	public actor: BreakpointActorProxy;
	
	public constructor(requestedLine: number, actualLine: number, actor: BreakpointActorProxy) {
		this.requestedLine = requestedLine;
		this.actualLine = actualLine;
		this.actor = actor;
	}
}

