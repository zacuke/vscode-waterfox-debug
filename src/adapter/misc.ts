import { Log } from '../util/log';
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
		if ((<FirefoxDebugProtocol.UrlSourceLocation>this.frame.where).source.url !== undefined) {
			sourcePath = (<FirefoxDebugProtocol.UrlSourceLocation>this.frame.where).source.url;
			if (sourcePath.substr(0, 7) == 'file://') {
				sourcePath = sourcePath.substr(7);
			}
		}
		
		let source = new Source('', sourcePath);

		let name: string;
		switch (this.frame.type) {

			case 'call':
				let callee = (<FirefoxDebugProtocol.CallFrame>this.frame).callee;
				if ((typeof callee === 'object') && (callee.type === 'object') && 
					((<FirefoxDebugProtocol.ObjectGrip>callee).class === 'Function')) {

					let calleeName = (<FirefoxDebugProtocol.FunctionGrip>callee).name;
					name = (calleeName !== undefined) ? calleeName : '[anonymous function]';

				} else {

					Log.error(`Unexpected callee in call frame: ${JSON.stringify(callee)}`);
					name = '[unknown]';

				}
				break;
				
			case 'global':
				name = '[Global]';
				break;
				
			case 'eval':
			case 'clientEvaluate':
				name = '[eval]';
				break;
				
			default:
				name = `[${this.frame.type}]`;
				Log.error(`Unexpected frame type ${this.frame.type}`);
				break;
		}
		
		return new StackFrame(this.id, name, source, this.frame.where.line, this.frame.where.column);
	}
}
