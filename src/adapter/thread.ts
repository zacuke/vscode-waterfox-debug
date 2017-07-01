import { Log } from '../util/log';
import { EventEmitter } from 'events';
import { concatArrays } from '../util/misc';
import { ExceptionBreakpoints, IThreadActorProxy, ConsoleActorProxy, ISourceActorProxy } from '../firefox/index';
import { ThreadCoordinator, ThreadPauseCoordinator, BreakpointInfo, BreakpointsAdapter, FrameAdapter, ScopeAdapter, SourceAdapter, BreakpointAdapter, ObjectGripAdapter, VariablesProvider, VariableAdapter } from './index';
import { FirefoxDebugAdapter } from '../firefoxDebugAdapter';
import { Variable } from 'vscode-debugadapter';

let log = Log.create('ThreadAdapter');

export class ThreadAdapter extends EventEmitter {

	public id: number;
	public get actorName() {
		return this.actor.name;
	}
	public get hasConsole() {
		return this.consoleActor !== undefined;
	}

	private coordinator: ThreadCoordinator;

	private sources: SourceAdapter[] = [];
	private frames: FrameAdapter[] = [];
	private scopes: ScopeAdapter[] = [];

	private pauseLifetimeObjects: ObjectGripAdapter[] = [];
	private threadLifetimeObjects: ObjectGripAdapter[] = [];

	private threadPausedReason?: FirefoxDebugProtocol.ThreadPausedReason;

	public constructor(
		public readonly actor: IThreadActorProxy,
		private readonly consoleActor: ConsoleActorProxy | undefined,
		private readonly pauseCoordinator: ThreadPauseCoordinator,
		public readonly name: string,
		public readonly debugAdapter: FirefoxDebugAdapter
	) {
		super();

		this.id = debugAdapter.threads.register(this);
		this.consoleActor = consoleActor;

		this.coordinator = new ThreadCoordinator(this.id, this.name, this.actor, this.consoleActor,
			this.pauseCoordinator, () => this.disposePauseLifetimeAdapters());

		this.coordinator.onPaused(async (reason) => {

			this.threadPausedReason = reason;

			await this.fetchAllStackFrames();

			if (this.shouldSkip(this.frames[0].frame.where.source)) {
				this.resume();
			} else {
				this.emit('paused', reason);
			}
		});
	}

	public async init(exceptionBreakpoints: ExceptionBreakpoints, reload: boolean): Promise<void> {

		this.coordinator.setExceptionBreakpoints(exceptionBreakpoints);

		await this.pauseCoordinator.requestInterrupt(this.id, this.name, 'auto');
		try {
			await this.actor.attach();
			this.pauseCoordinator.notifyInterrupted(this.id, this.name, 'auto');
		} catch(e) {
			this.pauseCoordinator.notifyInterruptFailed(this.id, this.name);
			throw e;
		}

		await this.actor.fetchSources();

		await this.coordinator.resume();

		if (reload) {
			await this.consoleEvaluate('location.reload(true)');
		}
	}

	public createSourceAdapter(actor: ISourceActorProxy, path?: string): SourceAdapter {
		let adapter = new SourceAdapter(this.debugAdapter.sources, actor, path);
		this.sources.push(adapter);
		return adapter;
	}

	public registerScopeAdapter(scopeAdapter: ScopeAdapter) {
		this.scopes.push(scopeAdapter);
	}

	public registerObjectGripAdapter(objectGripAdapter: ObjectGripAdapter) {
		if (objectGripAdapter.threadLifetime) {
			this.threadLifetimeObjects.push(objectGripAdapter);
		} else {
			this.pauseLifetimeObjects.push(objectGripAdapter);
		}
	}

	public findCorrespondingSourceAdapter(source: FirefoxDebugProtocol.Source): SourceAdapter | undefined {
		if (!source.url) return undefined;

		for (let sourceAdapter of this.sources) {
			if (sourceAdapter.actor.source.url === source.url) {
				return sourceAdapter;
			}
		}

		return undefined;
	}

	public findSourceAdaptersForPath(path: string | undefined): SourceAdapter[] {
		if (!path) return [];
		return this.sources.filter((sourceAdapter) => (sourceAdapter.sourcePath === path));
	}

	public findSourceAdapterForActorName(actorName: string): SourceAdapter | undefined {
		for (let i = 0; i < this.sources.length; i++) {
			if (this.sources[i].actor.name === actorName) {
				return this.sources[i];
			}
		}
		return undefined;
	}

	public interrupt(): Promise<void> {
		return this.coordinator.interrupt();
	}

	public resume(): Promise<void> {
		return this.coordinator.resume();
	}

	public stepOver(): Promise<void> {
		return this.coordinator.stepOver();
	}

	public stepIn(): Promise<void> {
		return this.coordinator.stepIn();
	}

	public stepOut(): Promise<void> {
		return this.coordinator.stepOut();
	}

	public setBreakpoints(breakpointInfos: BreakpointInfo[], sourceAdapter: SourceAdapter): Promise<BreakpointAdapter[]> {
		return BreakpointsAdapter.setBreakpointsOnSourceActor(breakpointInfos, sourceAdapter, this.coordinator);
	}

	public setExceptionBreakpoints(exceptionBreakpoints: ExceptionBreakpoints) {
		this.coordinator.setExceptionBreakpoints(exceptionBreakpoints);
	}

	private fetchAllStackFrames(): Promise<FrameAdapter[]> {
		return this.coordinator.runOnPausedThread(

			async () => {

				let frames = await this.actor.fetchStackFrames();

				let frameAdapters = frames.map((frame) => {
					let frameAdapter = new FrameAdapter(this.debugAdapter.frames, frame, this);
					this.frames.push(frameAdapter);
					return frameAdapter;
				});

				if ((this.threadPausedReason !== undefined) && (frameAdapters.length > 0)) {

					if (this.threadPausedReason.frameFinished !== undefined) {

						if (this.threadPausedReason.frameFinished.return !== undefined) {

							frameAdapters[0].scopeAdapters[0].addReturnValue(
								this.threadPausedReason.frameFinished.return);

						} else if (this.threadPausedReason.frameFinished.throw !== undefined) {

							frameAdapters[0].scopeAdapters.unshift(ScopeAdapter.fromGrip(
								'Exception', this.threadPausedReason.frameFinished.throw, frameAdapters[0]));
						}

					} else if (this.threadPausedReason.exception !== undefined) {

							frameAdapters[0].scopeAdapters.unshift(ScopeAdapter.fromGrip(
								'Exception', this.threadPausedReason.exception, frameAdapters[0]));
					}
				}

				return frameAdapters;
			},

			async (frameAdapters) => {

				let objectGripAdapters = concatArrays(frameAdapters.map(
					(frameAdapter) => frameAdapter.getObjectGripAdapters()));

				await this.actor.threadGrips(
					Array.from(new Set(objectGripAdapters.map(
						objectGripAdapter => objectGripAdapter.actor.name
				))));
			}
		);
	}

	public async fetchStackFrames(start: number, count: number): Promise<[FrameAdapter[], number]> {

		let frameAdapters = (this.frames.length > 0) ? this.frames : await this.fetchAllStackFrames();

		let requestedFrames = (count > 0) ? frameAdapters.slice(start, start + count) : frameAdapters.slice(start);

		return [requestedFrames, frameAdapters.length];
	}

	public async fetchVariables(variablesProvider: VariablesProvider): Promise<Variable[]> {

		let variableAdapters = await this.coordinator.runOnPausedThread(

			() => variablesProvider.getVariables(),

			async (variableAdapters) => {

				if (!variablesProvider.threadLifetime) {

					let objectGripAdapters = variableAdapters
						.map((variableAdapter) => variableAdapter.objectGripAdapter)
						.filter((objectGripAdapter) => (objectGripAdapter !== undefined));

					await this.actor.threadGrips(
						Array.from(new Set(objectGripAdapters.map(
							objectGripAdapter => objectGripAdapter!.actor.name
					))));
				}
			}
		);

		return variableAdapters.map((variableAdapter) => variableAdapter.getVariable());
	}

	public async evaluate(expr: string, frameActorName?: string): Promise<Variable> {

		let variableAdapter: VariableAdapter;
		if (frameActorName !== undefined) {

			variableAdapter = await this.coordinator.evaluate(expr, frameActorName, 

				(grip) => this.variableFromGrip(grip, false),

				async (variableAdapter) => {
					let objectGripAdapter = variableAdapter.objectGripAdapter;
					if (objectGripAdapter !== undefined) {
						await objectGripAdapter.actor.extendLifetime();
					}
				}
			);

		} else {

			variableAdapter = await this.coordinator.consoleEvaluate(expr, undefined, 
				(grip) => this.variableFromGrip(grip, true));

		}

		return variableAdapter.getVariable();
	}

	public async consoleEvaluate(expr: string, frameActorName?: string): Promise<Variable> {

		let grip = await this.consoleActor!.evaluate(expr, frameActorName);

		let variableAdapter = this.variableFromGrip(grip, true);

		return variableAdapter.getVariable();
	}

	public async autoComplete(text: string, column: number, frameActorName?: string): Promise<string[]> {
		return await this.consoleActor!.autoComplete(text, column, frameActorName);
	}

	public detach(): Promise<void> {
		return this.actor.detach();
	}

	private variableFromGrip(grip: FirefoxDebugProtocol.Grip | undefined, threadLifetime: boolean): VariableAdapter {
		if (grip !== undefined) {
			return VariableAdapter.fromGrip('', undefined, undefined, grip, threadLifetime, this);
		} else {
			return new VariableAdapter('', undefined, undefined, 'undefined', this);
		}
	}

	private shouldSkip(source: FirefoxDebugProtocol.Source) {
		let sourceAdapter = this.findSourceAdapterForActorName(source.actor);
		if (sourceAdapter !== undefined) {
			return sourceAdapter.actor.source.isBlackBoxed;
		} else {
			log.warn(`No adapter found for sourceActor ${source.actor}`);
			return false;
		}
	}

	private async disposePauseLifetimeAdapters(threadIsGone: boolean = false): Promise<void> {

		this.scopes.forEach((scopeAdapter) => {
			scopeAdapter.dispose();
		});
		this.scopes = [];

		this.frames.forEach((frameAdapter) => {
			frameAdapter.dispose();
		});
		this.frames = [];

		this.pauseLifetimeObjects.forEach((objectGripAdapter) => {
			objectGripAdapter.dispose();
		});

		if (!threadIsGone) {

			let objectGripActorsToRelease = this.pauseLifetimeObjects
			.filter((objectGripAdapter) => (objectGripAdapter.actor.refCount === 0))
			.map((objectGripAdapter) => objectGripAdapter.actor.name);

			if (objectGripActorsToRelease.length > 0) {
				try {
					await this.actor.releaseMany(objectGripActorsToRelease);
				} catch(err) {}
			}
		}

		this.pauseLifetimeObjects = [];
	}

	public async dispose(threadIsGone: boolean): Promise<void> {

		await this.disposePauseLifetimeAdapters(threadIsGone);

		this.threadLifetimeObjects.forEach((objectGripAdapter) => {
			objectGripAdapter.dispose();
		});

		if (!threadIsGone) {

			let objectGripActorsToRelease = this.threadLifetimeObjects
			.filter((objectGripAdapter) => (objectGripAdapter.actor.refCount === 0))
			.map((objectGripAdapter) => objectGripAdapter.actor.name);

			if (objectGripActorsToRelease.length > 0) {
				try {
					await this.actor.releaseMany(objectGripActorsToRelease);
				} catch(err) {}
			}
		}

		this.sources.forEach((source) => {
			source.dispose();
		});

		this.actor.dispose();
		if (this.consoleActor !== undefined) {
			this.consoleActor.dispose();
		}
	}

	public onPaused(cb: (reason: FirefoxDebugProtocol.ThreadPausedReason) => void) {
		this.on('paused', cb);
	}

	public onResumed(cb: () => void) {
		this.actor.onResumed(cb);
	}
	
	public onExited(cb: () => void) {
		this.actor.onExited(cb);
	}

	public onWrongState(cb: () => void) {
		this.actor.onWrongState(cb);
	}

	public onNewSource(cb: (newSource: ISourceActorProxy) => void) {
		this.actor.onNewSource(cb);
	}
}
