import { Log } from '../util/log';
import { concatArrays } from '../util/misc';
import { ExceptionBreakpoints, ThreadActorProxy, SourceActorProxy } from '../firefox/index';
import { ThreadCoordinator, BreakpointInfo, BreakpointsAdapter, FrameAdapter, ScopeAdapter, SourceAdapter, BreakpointAdapter, ObjectGripAdapter, VariablesProvider, VariableAdapter } from './index';
import { FirefoxDebugSession } from '../firefoxDebugSession';
import { Variable } from 'vscode-debugadapter';

export class ThreadAdapter {
	
	public id: number;
	public get debugSession() {
		return this._debugSession;
	}
	public get actorName() {
		return this.actor.name;
	}
	
	private _debugSession: FirefoxDebugSession;
	private actor: ThreadActorProxy;
	private coordinator: ThreadCoordinator;
	
	private sources: SourceAdapter[] = [];
	private frames: FrameAdapter[] = [];
	private scopes: ScopeAdapter[] = [];
	
	private objectGripAdaptersByActorName = new Map<string, ObjectGripAdapter>();
	private pauseLifetimeObjects: ObjectGripAdapter[] = [];
	private threadLifetimeObjects: ObjectGripAdapter[] = [];
	
	private completionValue: FirefoxDebugProtocol.CompletionValue;
	
	public constructor(id: number, actor: ThreadActorProxy, debugSession: FirefoxDebugSession) {
		this.id = id;
		this.actor = actor;
		this._debugSession = debugSession;
	}
	
	public init(exceptionBreakpoints: ExceptionBreakpoints): Promise<void> {
		this.actor.onPaused((reason) => {
			this.completionValue = reason.frameFinished;
		});
		this.coordinator = new ThreadCoordinator(this.actor);
		return this.actor.attach().then(() => {
			this.coordinator.setExceptionBreakpoints(exceptionBreakpoints);
			return this.actor.fetchSources().then(
				() => this.coordinator.resume(() => Promise.resolve(undefined)));
		});
	}

	public createSourceAdapter(id: number, actor: SourceActorProxy): SourceAdapter {
		let adapter = new SourceAdapter(id, actor);
		this.sources.push(adapter);
		return adapter;
	}
	
	public getOrCreateObjectGripAdapter(objectGrip: FirefoxDebugProtocol.ObjectGrip, threadLifetime: boolean) {
		
		let objectGripAdapter = this.objectGripAdaptersByActorName.get(objectGrip.actor);
		
		if (objectGripAdapter !== undefined) {
			
			// extend the lifetime of the found ObjectGripAdapter if necessary 
			if (threadLifetime && !objectGripAdapter.isThreadLifetime) {
				this.pauseLifetimeObjects.splice(this.pauseLifetimeObjects.indexOf(objectGripAdapter), 1);
				this.threadLifetimeObjects.push(objectGripAdapter);
				objectGripAdapter.isThreadLifetime = true;
			}
		
		} else {

			// create new ObjectGripAdapter
			objectGripAdapter = new ObjectGripAdapter(objectGrip, threadLifetime, this);
			this.objectGripAdaptersByActorName.set(objectGrip.actor, objectGripAdapter);
			if (threadLifetime) {
				this.threadLifetimeObjects.push(objectGripAdapter);
			} else {
				this.pauseLifetimeObjects.push(objectGripAdapter);
			}
			
		}
			
		return objectGripAdapter;
	}

	public registerScopeAdapter(scopeAdapter: ScopeAdapter) {
		this.scopes.push(scopeAdapter);
	}

	public findSourceAdapterForUrl(url: string): SourceAdapter {
		for (let i = 0; i < this.sources.length; i++) {
			if (this.sources[i].actor.url === url) {
				return this.sources[i];
			}
		}
		return null;
	}
	
	public findSourceAdapterForActorName(actorName: string): SourceAdapter {
		for (let i = 0; i < this.sources.length; i++) {
			if (this.sources[i].actor.name === actorName) {
				return this.sources[i];
			}
		}
		return null;
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
	
	public fetchStackFrames(levels: number): Promise<FrameAdapter[]> {
		return this.coordinator.runOnPausedThread((finished) => 

			this.actor.fetchStackFrames(levels).then(
				(frames) => {
					let frameAdapters = frames.map((frame) => {
						let frameAdapter = new FrameAdapter(frame, this);
						this._debugSession.registerFrameAdapter(frameAdapter);
						this.frames.push(frameAdapter);
						return frameAdapter;
					});
					
					if (frameAdapters.length > 0) {
						frameAdapters[0].scopeAdapters[0].addCompletionValue(this.completionValue);
					}
					
					let objectGripAdapters = concatArrays(frameAdapters.map(
						(frameAdapter) => frameAdapter.getObjectGripAdapters()));
					
					let extendLifetimePromises = objectGripAdapters.map((objectGripAdapter) => 
						objectGripAdapter.actor.extendLifetime().catch((err) => undefined));
					
					Promise.all(extendLifetimePromises).then(() => finished());

					return frameAdapters;
				},
				(err) => {
					finished();
					throw err;
				})
		);
	}

	public fetchVariables(variablesProvider: VariablesProvider): Promise<Variable[]> {
		return this.coordinator.runOnPausedThread((finished) => 
			variablesProvider.getVariables().then(
				(variableAdapters) => {
					
					let objectGripAdapters = variableAdapters
						.map((variableAdapter) => variableAdapter.getObjectGripAdapter())
						.filter((objectGripAdapter) => (objectGripAdapter != null));
					
					let extendLifetimePromises = objectGripAdapters.map((objectGripAdapter) => 
						objectGripAdapter.actor.extendLifetime().catch((err) => undefined));
					
					Promise.all(extendLifetimePromises).then(() => finished());

					return variableAdapters.map(
						(variableAdapter) => variableAdapter.getVariable());
						
				},
				(err) => {
					finished();
					throw err;
				}
			)
		);
	}
	
	public evaluate(expression: string, frameActorName: string, threadLifetime: boolean): Promise<Variable> {
		return this.coordinator.evaluate(expression, frameActorName).then(([grip, finished]) => {
				
			let variableAdapter: VariableAdapter;
			if (grip) {
				variableAdapter = VariableAdapter.fromGrip('', grip, threadLifetime, this);
			} else {
				variableAdapter = new VariableAdapter('', 'undefined');
			}

			let objectGripAdapter = variableAdapter.getObjectGripAdapter();
			if (objectGripAdapter) {
				objectGripAdapter.actor.extendLifetime().then(
					() => finished(),
					(err) => finished());
			} else {
				finished();
			}

			return variableAdapter.getVariable();
		});
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
