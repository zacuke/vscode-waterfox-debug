import { Log } from '../util/log';
import { concatArrays } from '../util/misc';
import { ThreadAdapter, EnvironmentAdapter, ScopeAdapter, ObjectGripAdapter } from '../adapter/index';
import { DebugProtocol } from 'vscode-debugprotocol';
import { Source, StackFrame } from 'vscode-debugadapter';
import { Registry } from "./registry";

let log = Log.create('FrameAdapter');

let actorIdRegex = /[0-9]+$/;

export class FrameAdapter {

	public readonly id: number;
	public readonly scopeAdapters: ScopeAdapter[];

	public constructor(
		private readonly frameRegistry: Registry<FrameAdapter>,
		public readonly frame: FirefoxDebugProtocol.Frame,
		public readonly threadAdapter: ThreadAdapter
	) {
		this.id = frameRegistry.register(this);
		let environmentAdapter = EnvironmentAdapter.from(this.frame.environment);
		this.scopeAdapters = environmentAdapter.getScopeAdapters(this);
		this.scopeAdapters[0].addThis(this.frame.this);
	}

	public getStackframe(): StackFrame {

		let firefoxSource = this.frame.where.source;
		let sourceActorName = firefoxSource.actor;

		let sourcePath = this.threadAdapter.debugAdapter.pathMapper.convertFirefoxSourceToPath(firefoxSource);
		let sourceName = '';

		if (firefoxSource.url != null) {
			sourceName = firefoxSource.url.split('/').pop()!.split('#')[0];
		} else if (this.frame.type === 'eval') {
			let match = actorIdRegex.exec(sourceActorName);
			if (match) {
				sourceName = `eval ${match[0]}`;
			}
		}

		let sourceAdapter = this.threadAdapter.findSourceAdapterForActorName(sourceActorName);
		if (!sourceAdapter) {
			throw new Error(`Couldn't find source adapter for ${sourceActorName}`);
		}

		let source: Source;
		if (sourcePath !== undefined) {
			source = new Source(sourceName, sourcePath);
		} else {
			source = new Source(sourceName, firefoxSource.url || undefined, sourceAdapter.id);
		}

		if (sourceAdapter.actor.source.isBlackBoxed) {
			(<DebugProtocol.Source>source).presentationHint = 'deemphasize';
		}

		let name: string;
		switch (this.frame.type) {

			case 'call':
				let callee = (<FirefoxDebugProtocol.CallFrame>this.frame).callee;
				if ((typeof callee === 'object') && (callee.type === 'object') && 
					((<FirefoxDebugProtocol.ObjectGrip>callee).class === 'Function')) {

					let functionGrip = (<FirefoxDebugProtocol.FunctionGrip>callee);
					let calleeName = functionGrip.name || functionGrip.displayName;
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

		let result = new StackFrame(this.id, name, source, this.frame.where.line, this.frame.where.column);
		(<DebugProtocol.StackFrame>result).moduleId = 'bla';
		return result;
	}

	public getObjectGripAdapters(): ObjectGripAdapter[] {
		return concatArrays(this.scopeAdapters.map(
			(scopeAdapter) => scopeAdapter.getObjectGripAdapters()));
	}
	
	public dispose(): void {
		this.frameRegistry.unregister(this.id);
	}
}
