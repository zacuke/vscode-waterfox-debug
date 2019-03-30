import { EventEmitter } from 'events';
import { ExceptionBreakpoints, IThreadActorProxy, ConsoleActorProxy, ISourceActorProxy } from '../firefox/index';
import { ThreadCoordinator, ThreadPauseCoordinator, FrameAdapter, ScopeAdapter, SourceAdapter, ObjectGripAdapter, VariablesProvider, VariableAdapter } from './index';
import { Variable } from 'vscode-debugadapter';
import { Log } from '../util/log';
import { FirefoxDebugSession } from "../firefoxDebugSession";
import { pathsAreEqual } from '../util/misc';
import { Location } from '../firefox/actorProxy/source';
import { AttachOptions } from '../firefox/actorProxy/thread';
import { BreakpointAdapter } from './misc';

let log = Log.create('ThreadAdapter');

export interface SourceLocation extends Location {
	source: SourceAdapter;
}

export class ThreadAdapter extends EventEmitter {

	public id: number;
	public get actorName() {
		return this.actor.name;
	}

	public readonly coordinator: ThreadCoordinator;

	private sources: SourceAdapter[] = [];
	private framesPromise: Promise<FrameAdapter[]> | undefined = undefined;
	private scopes: ScopeAdapter[] = [];

	private pauseLifetimeObjects: ObjectGripAdapter[] = [];
	private threadLifetimeObjects: ObjectGripAdapter[] = [];

	public constructor(
		public readonly actor: IThreadActorProxy,
		private readonly consoleActor: ConsoleActorProxy,
		private readonly pauseCoordinator: ThreadPauseCoordinator,
		public readonly name: string,
		public readonly debugSession: FirefoxDebugSession
	) {
		super();

		this.id = debugSession.threads.register(this);

		this.coordinator = new ThreadCoordinator(this.id, this.name, this.actor, this.consoleActor,
			this.pauseCoordinator, () => this.disposePauseLifetimeAdapters());

		this.coordinator.onPaused(async (event) => {

			// Firefox doesn't apply source-maps to the sources in pausedEvents for exceptions
			const distrustSourceInPausedEvent =
				((event.why.type === 'exception') &&
				 (debugSession.config.sourceMaps === 'server'));

			let sourceLocation: FirefoxDebugProtocol.SourceLocation;
			if (!distrustSourceInPausedEvent) {
				sourceLocation = event.frame.where;
			} else {
				let frames = await this.fetchAllStackFrames();
				sourceLocation = frames[0].frame.where;
			}

			const sourceActor = sourceLocation.actor || sourceLocation.source!.actor;
			const sourceAdapter = this.findSourceAdapterForActorName(sourceActor);

			if (sourceAdapter) {

				if (sourceAdapter.actor.source.isBlackBoxed) {

					this.resume();
					return;

				}

				if ((event.why.type === 'breakpoint') &&
					event.why.actors && (event.why.actors.length > 0)) {

					let breakpointAdapter: BreakpointAdapter | undefined;
					if (this.debugSession.newBreakpointProtocol) {
						breakpointAdapter = sourceAdapter.findBreakpointAdapterForLocation(sourceLocation);
					} else {
						breakpointAdapter = sourceAdapter.findBreakpointAdapterForActorName(event.why.actors[0]);
					}

					if (breakpointAdapter) {

						if (breakpointAdapter.breakpointInfo.hitCount) {

							breakpointAdapter.hitCount++;
							if (breakpointAdapter.hitCount < breakpointAdapter.breakpointInfo.hitCount) {

								this.resume();
								return;

							}
						}

						const logMessage = breakpointAdapter.breakpointInfo.requestedBreakpoint.logMessage;
						if (logMessage && !this.debugSession.newBreakpointProtocol) {

							const frames = await this.fetchAllStackFrames();
							const frameActor = (frames.length > 0) ? frames[0].frame.actor : undefined;

							this.evaluate(`console.log(\`${logMessage.replace('{', '${')}\`)`, false, frameActor);

							this.resume();
							return;

						}
					}
				}
			}

			if (event.why.type === 'exception') {

				let frames = await this.fetchAllStackFrames();
				let startFrame = (frames.length > 0) ? frames[frames.length - 1] : undefined;
				if (startFrame) {

					let source = startFrame.frame.where.source;
					if (!source) {
						const sourceAdapter = this.findSourceAdapterForActorName(startFrame.frame.where.actor!);
						if (sourceAdapter) {
							source = sourceAdapter.actor.source;
						} else {
							log.warn(`Couldn't find SourceAdapter for ${startFrame.frame.where.actor}`);
						}
					}

					if (source && source.introductionType === 'debugger eval') {

						this.resume();
						return;

					}
				}
			}

			this.emit('paused', event.why);
			// pre-fetch the stackframes, we're going to need them later
			this.fetchAllStackFrames();
		});
	}

	public async init(exceptionBreakpoints: ExceptionBreakpoints): Promise<void> {

		const attachOptions: AttachOptions = {};
		if (this.debugSession.config.sourceMaps === 'server') {
			attachOptions.useSourceMaps = true;
		}
		if (this.debugSession.newBreakpointProtocol) {
			attachOptions.pauseOnExceptions = (exceptionBreakpoints !== ExceptionBreakpoints.None);
			attachOptions.ignoreCaughtExceptions = (exceptionBreakpoints !== ExceptionBreakpoints.All);
		} else {
			this.coordinator.setExceptionBreakpoints(exceptionBreakpoints);
		}

		await this.pauseCoordinator.requestInterrupt(this.id, this.name, 'auto');
		try {
			await this.actor.attach(attachOptions);
			this.pauseCoordinator.notifyInterrupted(this.id, this.name, 'auto');
		} catch(e) {
			this.pauseCoordinator.notifyInterruptFailed(this.id, this.name);
			throw e;
		}

		await this.actor.fetchSources();

		await this.coordinator.resume();
	}

	public createSourceAdapter(actor: ISourceActorProxy, path: string | undefined, newBreakpointProtocol: boolean): SourceAdapter {
		let adapter = new SourceAdapter(this.debugSession.sources, actor, path, this, newBreakpointProtocol);
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

	public findCorrespondingSourceAdapter(url: string | undefined): SourceAdapter | undefined {
		if (!url) return undefined;

		for (let sourceAdapter of this.sources) {
			if (sourceAdapter.actor.source.url === url) {
				return sourceAdapter;
			}
		}

		return undefined;
	}

	public findSourceAdaptersForPathOrUrl(pathOrUrl: string): SourceAdapter[] {
		if (!pathOrUrl) return [];

		return this.sources.filter((sourceAdapter) =>
			pathsAreEqual(pathOrUrl, sourceAdapter.sourcePath) || (sourceAdapter.actor.url === pathOrUrl)
		);
	}

	public findSourceAdaptersForUrlWithoutQuery(url: string): SourceAdapter[] {

		return this.sources.filter((sourceAdapter) => {

			let sourceUrl = sourceAdapter.actor.url;
			if (!sourceUrl) return false;

			let queryStringIndex = sourceUrl.indexOf('?');
			if (queryStringIndex >= 0) {
				sourceUrl = sourceUrl.substr(0, queryStringIndex);
			}

			return url === sourceUrl;
		});
	}

	public findSourceAdapterForActorName(actorName: string): SourceAdapter | undefined {

		for (let i = 0; i < this.sources.length; i++) {
			if (this.sources[i].actor.name === actorName) {
				return this.sources[i];
			}
		}

		return undefined;
	}

	public async findOriginalSourceLocation(
		generatedUrl: string,
		line: number,
		column?: number
	): Promise<SourceLocation | undefined> {

		const originalLocation = await this.actor.findOriginalLocation(generatedUrl, line, column);
		if (originalLocation) {
			const sourceAdapter = this.findCorrespondingSourceAdapter(originalLocation.url);
			if (sourceAdapter) {
				return {
					source: sourceAdapter,
					line: originalLocation.line,
					column: originalLocation.column
				};
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

	public setExceptionBreakpoints(exceptionBreakpoints: ExceptionBreakpoints) {
		if (this.debugSession.newBreakpointProtocol) {
			const pauseOnExceptions = (exceptionBreakpoints !== ExceptionBreakpoints.None);
			const ignoreCaughtExceptions = (exceptionBreakpoints !== ExceptionBreakpoints.All);
			this.actor.pauseOnExceptions(pauseOnExceptions, ignoreCaughtExceptions);
		} else {
			this.coordinator.setExceptionBreakpoints(exceptionBreakpoints);
		}
	}

	private fetchAllStackFrames(): Promise<FrameAdapter[]> {

		if (!this.framesPromise) {
			this.framesPromise = this.coordinator.runOnPausedThread(

				async () => {

					let frames = await this.actor.fetchStackFrames();

					let frameAdapters = frames.map((frame) =>
						new FrameAdapter(this.debugSession.frames, frame, this));

					let threadPausedReason = this.coordinator.threadPausedReason;
					if ((threadPausedReason !== undefined) && (frameAdapters.length > 0)) {

						if (threadPausedReason.frameFinished !== undefined) {

							if (threadPausedReason.frameFinished.return !== undefined) {

								frameAdapters[0].scopeAdapters[0].addReturnValue(
									threadPausedReason.frameFinished.return);

							} else if (threadPausedReason.frameFinished.throw !== undefined) {

								frameAdapters[0].scopeAdapters.unshift(ScopeAdapter.fromGrip(
									'Exception', threadPausedReason.frameFinished.throw, frameAdapters[0]));
							}

						} else if (threadPausedReason.exception !== undefined) {

								frameAdapters[0].scopeAdapters.unshift(ScopeAdapter.fromGrip(
									'Exception', threadPausedReason.exception, frameAdapters[0]));
						}
					}

					return frameAdapters;
				}
			);
		}

		return this.framesPromise;
	}

	public async fetchStackFrames(start: number, count: number): Promise<[FrameAdapter[], number]> {

		let frameAdapters = await this.fetchAllStackFrames();

		let requestedFrames = (count > 0) ? frameAdapters.slice(start, start + count) : frameAdapters.slice(start);

		return [requestedFrames, frameAdapters.length];
	}

	public triggerStackframeRefresh(): void {
		if (this.coordinator.threadTarget === 'paused') {
			this.debugSession.sendStoppedEvent(this, this.coordinator.threadPausedReason);
		}
	}

	public async fetchVariables(variablesProvider: VariablesProvider): Promise<Variable[]> {

		let variableAdapters = await variablesProvider.getVariables();

		return variableAdapters.map((variableAdapter) => variableAdapter.getVariable());
	}

	public async evaluate(expr: string, skipBreakpoints: boolean, frameActorName?: string): Promise<Variable> {

		if (skipBreakpoints) {

			let grip = await this.coordinator.evaluate(expr, frameActorName);
			let variableAdapter = this.variableFromGrip(grip, (frameActorName === undefined));
			return variableAdapter.getVariable();

		} else {

			let grip = await this.consoleActor.evaluate(expr, frameActorName);
			let variableAdapter = this.variableFromGrip(grip, true);
			return variableAdapter.getVariable();
		}
	}

	public async autoComplete(text: string, column: number, frameActorName?: string): Promise<string[]> {
		return await this.consoleActor.autoComplete(text, column, frameActorName);
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

	private async disposePauseLifetimeAdapters(): Promise<void> {

		if (this.framesPromise) {
			let frames = await this.framesPromise;
			frames.forEach((frameAdapter) => {
				frameAdapter.dispose();
			});
			this.framesPromise = undefined;
		}

		this.scopes.forEach((scopeAdapter) => {
			scopeAdapter.dispose();
		});
		this.scopes = [];

		this.pauseLifetimeObjects.forEach((objectGripAdapter) => {
			objectGripAdapter.dispose();
		});

		this.pauseLifetimeObjects = [];
	}

	public async dispose(): Promise<void> {

		await this.disposePauseLifetimeAdapters();

		this.threadLifetimeObjects.forEach((objectGripAdapter) => {
			objectGripAdapter.dispose();
		});

		this.sources.forEach((source) => {
			source.dispose();
		});

		this.actor.dispose();
		this.consoleActor.dispose();
	}

	public onPaused(cb: (event: FirefoxDebugProtocol.ThreadPausedReason) => void) {
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
