import { Log } from '../util/log';
import { ThreadActorProxy, SourceActorProxy } from '../firefox/index';
import { FrameAdapter, ScopeAdapter, SourceAdapter, ObjectGripAdapter } from './index';
import { FirefoxDebugSession } from '../firefoxDebugSession';

export class ThreadAdapter {
	
	public id: number;
	public actor: ThreadActorProxy;
	public get debugSession() {
		return this._debugSession;
	}
	
	private _debugSession: FirefoxDebugSession;
	
	private sources: SourceAdapter[] = [];
	private frames: FrameAdapter[] = [];
	private scopes: ScopeAdapter[] = [];
	
	private objectGripAdaptersByActorName = new Map<string, ObjectGripAdapter>();
	private pauseLifetimeObjects: ObjectGripAdapter[] = [];
	private threadLifetimeObjects: ObjectGripAdapter[] = [];
	
	public constructor(id: number, actor: ThreadActorProxy, debugSession: FirefoxDebugSession) {
		this.id = id;
		this.actor = actor;
		this._debugSession = debugSession;
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
	
	public disposePauseLifetimeAdapters() {
		
		let objectGripActorsToRelease = this.pauseLifetimeObjects.map(
			(objectGripAdapter) => objectGripAdapter.actorName);
		this.actor.releaseMany(objectGripActorsToRelease);
		
		this.pauseLifetimeObjects.forEach((objectGripAdapter) => {
			objectGripAdapter.dispose();
			this.objectGripAdaptersByActorName.delete(objectGripAdapter.actorName);
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
	}
	
	public fetchStackFrames(levels: number): Promise<FrameAdapter[]> {

		return this.actor.runOnPausedThread((finished) => 
			this.actor.fetchStackFrames(levels).then(
				([frames, completionValue]) => {

					let frameAdapters = frames.map((frame) => {
						let frameAdapter = new FrameAdapter(frame, this);
						this._debugSession.registerFrameAdapter(frameAdapter);
						this.frames.push(frameAdapter);
						return frameAdapter;
					});
					
					if (frameAdapters.length > 0) {
						frameAdapters[0].scopeAdapters[0].addCompletionValue(completionValue);
					}
					
					finished();
					
					return frameAdapters;
				},
				(err) => {
					finished();
					throw err;
				})
		);
	}
	
	public evaluate(expression: string, frameAdapter: FrameAdapter): Promise<FirefoxDebugProtocol.Grip> {
		return this.actor.evaluate(expression, frameAdapter.frame.actor);
	}
}
