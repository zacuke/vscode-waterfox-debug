import { Log } from '../util/log';
import { ThreadAdapter } from '../adapter/index';
import { Source, StackFrame } from 'vscode-debugadapter';

let log = Log.create('FrameAdapter');

export class FrameAdapter {
	public id: number;
	public frame: FirefoxDebugProtocol.Frame;
	public threadAdapter: ThreadAdapter;
	
	public constructor(id: number, frame: FirefoxDebugProtocol.Frame, threadAdapter: ThreadAdapter) {
		this.id = id;
		this.frame = frame;
		this.threadAdapter = threadAdapter;
	}
	
	public getStackframe(): StackFrame {

		let sourcePath: string = null;
		if ((<FirefoxDebugProtocol.UrlSourceLocation>this.frame.where).source.url != null) {
			sourcePath = (<FirefoxDebugProtocol.UrlSourceLocation>this.frame.where).source.url;
			if (sourcePath.substr(0, 7) === 'file://') {
				sourcePath = sourcePath.substr(7);
			}
		}
		
		let sourceId = 0;
		let sourceActorName = (<FirefoxDebugProtocol.UrlSourceLocation>this.frame.where).source.actor;
		for (var i = 0; i < this.threadAdapter.sources.length; i++) {
			if (this.threadAdapter.sources[i].actor.name == sourceActorName) {
				sourceId = this.threadAdapter.sources[i].id;
				break;
			}
		}

		let source = new Source('', sourcePath, sourceId);

		let name: string;
		switch (this.frame.type) {

			case 'call':
				let callee = (<FirefoxDebugProtocol.CallFrame>this.frame).callee;
				if ((typeof callee === 'object') && (callee.type === 'object') && 
					((<FirefoxDebugProtocol.ObjectGrip>callee).class === 'Function')) {

					let calleeName = (<FirefoxDebugProtocol.FunctionGrip>callee).name;
					name = (calleeName !== undefined) ? calleeName : '[anonymous function]';

				} else {

					log.error(`Unexpected callee in call frame: ${JSON.stringify(callee)}`);
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
				log.error(`Unexpected frame type ${this.frame.type}`);
				break;
		}
		
		return new StackFrame(this.id, name, source, this.frame.where.line, this.frame.where.column);
	}
}
