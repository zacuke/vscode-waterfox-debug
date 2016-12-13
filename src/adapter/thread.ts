import { Log } from '../util/log';
import { concatArrays } from '../util/misc';
import { ExceptionBreakpoints, ThreadActorProxy, ConsoleActorProxy, SourceActorProxy } from '../firefox/index';
import { ThreadCoordinator, BreakpointInfo, BreakpointsAdapter, FrameAdapter, ScopeAdapter, SourceAdapter, BreakpointAdapter, ObjectGripAdapter, VariablesProvider, VariableAdapter } from './index';
import { FirefoxDebugAdapter } from '../firefoxDebugAdapter';
import { Variable } from 'vscode-debugadapter';

export class ThreadAdapter {

	public id: number;
	public get debugSession() {
		return this._debugAdapter;
	}
	public get name() {
		return this._name;
	}
	public get actorName() {
		return this.actor.name;
	}

	private _debugAdapter: FirefoxDebugAdapter;
	private actor: ThreadActorProxy;
	private consoleActor?: ConsoleActorProxy;
	private coordinator: ThreadCoordinator;
	private _name: string;

	private sources: SourceAdapter[] = [];
	private frames: FrameAdapter[] = [];
	private scopes: ScopeAdapter[] = [];

	private objectGripAdaptersByActorName = new Map<string, ObjectGripAdapter>();
	private pauseLifetimeObjects: ObjectGripAdapter[] = [];

	private completionValue?: FirefoxDebugProtocol.CompletionValue;

	public constructor(id: number, threadActor: ThreadActorProxy, consoleActor: ConsoleActorProxy | undefined,
		name: string, debugAdapter: FirefoxDebugAdapter) {

		this.id = id;
		this.actor = threadActor;
		this.consoleActor = consoleActor;
		this._name = name;
		this._debugAdapter = debugAdapter;
	}

	public async init(exceptionBreakpoints: ExceptionBreakpoints): Promise<void> {

		this.actor.onPaused((reason) => {
			this.completionValue = reason.frameFinished;
		});

		this.coordinator = new ThreadCoordinator(this.actor);

		await this.actor.attach();
		this.coordinator.setExceptionBreakpoints(exceptionBreakpoints);
		await this.actor.fetchSources();
		this.coordinator.resume();
	}

	public createSourceAdapter(id: number, actor: SourceActorProxy, path?: string): SourceAdapter {
		let adapter = new SourceAdapter(id, actor, path);
		this.sources.push(adapter);
		return adapter;
	}

	public getOrCreateObjectGripAdapter(objectGrip: FirefoxDebugProtocol.ObjectGrip, threadLifetime: boolean) {

		let objectGripAdapter = this.objectGripAdaptersByActorName.get(objectGrip.actor);

		if (objectGripAdapter === undefined) {

			objectGripAdapter = new ObjectGripAdapter(objectGrip, threadLifetime, this);
			this.objectGripAdaptersByActorName.set(objectGrip.actor, objectGripAdapter);
			if (!threadLifetime) {
				this.pauseLifetimeObjects.push(objectGripAdapter);
			}

		}

		return objectGripAdapter;
	}

	public registerScopeAdapter(scopeAdapter: ScopeAdapter) {
		this.scopes.push(scopeAdapter);
	}

	public findSourceAdaptersForPath(path?: string): SourceAdapter[] {
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
		return this.coordinator.resume(() => this.disposePauseLifetimeAdapters());
	}

	public stepOver(): Promise<void> {
		return this.coordinator.resume(() => this.disposePauseLifetimeAdapters(), 'next');
	}

	public stepIn(): Promise<void> {
		return this.coordinator.resume(() => this.disposePauseLifetimeAdapters(), 'step');
	}

	public stepOut(): Promise<void> {
		return this.coordinator.resume(() => this.disposePauseLifetimeAdapters(), 'finish');
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
					let frameAdapter = new FrameAdapter(frame, this);
					this._debugAdapter.registerFrameAdapter(frameAdapter);
					this.frames.push(frameAdapter);
					return frameAdapter;
				});

				if (frameAdapters.length > 0) {
					frameAdapters[0].scopeAdapters[0].addCompletionValue(this.completionValue);
				}

				return frameAdapters;
			},

			async (frameAdapters) => {

				let objectGripAdapters = concatArrays(frameAdapters.map(
					(frameAdapter) => frameAdapter.getObjectGripAdapters()));

				let extendLifetimePromises = objectGripAdapters.map((objectGripAdapter) =>
					objectGripAdapter.actor.extendLifetime().catch((err) => undefined));

				await Promise.all(extendLifetimePromises);
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

				let objectGripAdapters = variableAdapters
					.map((variableAdapter) => variableAdapter.objectGripAdapter)
					.filter((objectGripAdapter) => (objectGripAdapter !== undefined));

				if (!variablesProvider.isThreadLifetime) {

					let extendLifetimePromises = objectGripAdapters.map((objectGripAdapter) =>
						objectGripAdapter!.actor.extendLifetime().catch((err) => undefined));

					await Promise.all(extendLifetimePromises);
				}
			}
		);

		return variableAdapters.map((variableAdapter) => variableAdapter.getVariable());
	}

	public async evaluate(expr: string, frameActorName: string): Promise<Variable> {

		let variableAdapter = await this.coordinator.evaluate(expr, frameActorName,

			(grip) => {
				if (grip) { //TODO can be undefined, but also false or 0 or ''...
					return VariableAdapter.fromGrip('', grip, false, this);
				} else {
					return new VariableAdapter('', 'undefined');
				}
			},

			async (variableAdapter) => {
				let objectGripAdapter = variableAdapter.objectGripAdapter;
				if (objectGripAdapter !== undefined) {
					await objectGripAdapter.actor.extendLifetime();
				}
			}
		);

		return variableAdapter.getVariable();
	}

	public async consoleEvaluate(expr: string, frameActorName?: string): Promise<Variable> {

		let grip = await this.consoleActor!.evaluate(expr, frameActorName);

		let variableAdapter: VariableAdapter;
		if (grip) {
			variableAdapter = VariableAdapter.fromGrip('', grip, true, this);
		} else {
			variableAdapter = new VariableAdapter('', 'undefined');
		}

		return variableAdapter.getVariable();
	}

	public detach(): Promise<void> {
		return this.actor.detach();
	}

	private disposePauseLifetimeAdapters(): Promise<void> {

		let objectGripActorsToRelease = this.pauseLifetimeObjects.map(
			(objectGripAdapter) => objectGripAdapter.actor.name);

		this.pauseLifetimeObjects.forEach((objectGripAdapter) => {
			objectGripAdapter.dispose();
			this.objectGripAdaptersByActorName.delete(objectGripAdapter.actor.name);
		});
		this.pauseLifetimeObjects = [];

		this.scopes.forEach((scopeAdapter) => {
			scopeAdapter.dispose();
		});
		this.scopes = [];

		this.frames.forEach((frameAdapter) => {
			frameAdapter.dispose();
		});
		this.frames = [];

		return this.actor.releaseMany(objectGripActorsToRelease).catch((err) => undefined);
	}
}
