import { ThreadActorProxy, SourceActorProxy, BreakpointActorProxy } from '../firefox/index';
import { Source, StackFrame } from 'vscode-debugadapter';

export class ThreadAdapter {
	public id: number;
	public actor: ThreadActorProxy;
	public sources: SourceAdapter[];
	
	public constructor(id: number, actor: ThreadActorProxy) {
		this.id = id;
		this.actor = actor;
		this.sources = [];
	}
}

export class SourceAdapter {
	public actor: SourceActorProxy;
	public currentBreakpoints: Promise<BreakpointAdapter[]>;
	
	public constructor(actor: SourceActorProxy) {
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

export class FrameAdapter {
	public id: number;
	public frame: FirefoxDebugProtocol.Frame;
	
	public constructor(id: number, frame: FirefoxDebugProtocol.Frame) {
		this.id = id;
		this.frame = frame;
	}
	
	public getStackframe(): StackFrame {
		let sourcePath: string = null;
		if ((<FirefoxDebugProtocol.UrlSourceLocation>this.frame.where).url !== undefined) {
			sourcePath = (<FirefoxDebugProtocol.UrlSourceLocation>this.frame.where).url;
		}
		let source = new Source('Some source', sourcePath);
		return new StackFrame(this.id, 'Some frame', source, this.frame.where.line, this.frame.where.column);
	}
}
