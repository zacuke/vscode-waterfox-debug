import { Log } from '../util/log';
import { concatArrays } from '../util/misc';
import { ThreadAdapter, EnvironmentAdapter, ScopeAdapter, ObjectGripAdapter } from '../adapter/index';
import { Source, StackFrame } from 'vscode-debugadapter';

let log = Log.create('FrameAdapter');

let actorIdRegex = /[0-9]+$/;

export class FrameAdapter {
	
	public id: number;
	public frame: FirefoxDebugProtocol.Frame;
	public scopeAdapters: ScopeAdapter[];
	public threadAdapter: ThreadAdapter;
	
	public constructor(frame: FirefoxDebugProtocol.Frame, threadAdapter: ThreadAdapter) {
		this.frame = frame;
		this.threadAdapter = threadAdapter;
		this.threadAdapter.debugSession.registerFrameAdapter(this);
		
		let environmentAdapter = EnvironmentAdapter.from(this.frame.environment);
		this.scopeAdapters = environmentAdapter.getScopeAdapters(this.threadAdapter);
		this.scopeAdapters[0].addThis(this.frame.this);
	}

	public getStackframe(): StackFrame {

		let sourcePath: string = null;
		if ((<FirefoxDebugProtocol.UrlSourceLocation>this.frame.where).source.url != null) {
			sourcePath = this.threadAdapter.debugSession.convertFirefoxUrlToPath(
				(<FirefoxDebugProtocol.UrlSourceLocation>this.frame.where).source.url);
		}

		let sourceName = '';
		if (this.frame.type === 'eval') {
			let actorName = (<FirefoxDebugProtocol.UrlSourceLocation>this.frame.where).source.actor;
			let match = actorIdRegex.exec(actorName);
			if (match) {
				sourceName = `eval ${match[0]}`;
			}
		}

		let sourceActorName = (<FirefoxDebugProtocol.UrlSourceLocation>this.frame.where).source.actor;
		let sourceAdapter = this.threadAdapter.findSourceAdapterForActorName(sourceActorName);

		let source = new Source(sourceName, sourcePath, sourceAdapter.id);

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

	public getObjectGripAdapters(): ObjectGripAdapter[] {
		return concatArrays(this.scopeAdapters.map(
			(scopeAdapter) => scopeAdapter.getObjectGripAdapters()));
	}
	
	public dispose(): void {
		this.threadAdapter.debugSession.unregisterFrameAdapter(this);
	}
}
