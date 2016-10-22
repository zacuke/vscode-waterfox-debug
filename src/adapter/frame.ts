import { Log } from '../util/log';
import { concatArrays } from '../util/misc';
import { ThreadAdapter, EnvironmentAdapter, ScopeAdapter, ObjectGripAdapter } from '../adapter/index';
import { Source, StackFrame } from 'vscode-debugadapter';
import { urlBasename } from '../util/misc';

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

		let firefoxSource = (<FirefoxDebugProtocol.UrlSourceLocation>this.frame.where).source;
		let sourceActorName = firefoxSource.actor;

		let sourcePath = '';
		let sourceName = '';

		if (firefoxSource.url != null) {
			sourcePath = this.threadAdapter.debugSession.convertFirefoxSourceToPath(firefoxSource) || ''; //TODO
			sourceName = urlBasename(firefoxSource.url);
		}

		if (this.frame.type === 'eval') {
			let match = actorIdRegex.exec(sourceActorName);
			if (match) {
				sourceName = `eval ${match[0]}`;
			}
		}

		let sourceAdapter = this.threadAdapter.findSourceAdapterForActorName(sourceActorName);
		if (!sourceAdapter) {
			throw new Error(`Couldn't find source adapter for ${sourceActorName}`);
		}

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
