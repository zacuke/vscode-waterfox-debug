import { Log } from '../util/log';
import { ThreadActorProxy } from '../firefox/index';
import { FrameAdapter, ScopeAdapter, SourceAdapter, ObjectGripAdapter } from './index';
import { FirefoxDebugSession } from '../firefoxDebugSession';

export class ThreadAdapter {
	
	public id: number;
	public actor: ThreadActorProxy;
	public sources: SourceAdapter[] = []; //TODO make private
	public get debugSession() {
		return this._debugSession;
	}
	
	private _debugSession: FirefoxDebugSession;
	
	private objectGripAdaptersByActorName = new Map<string, ObjectGripAdapter>();
	private pauseLifetimeObjects: ObjectGripAdapter[] = [];
	private threadLifetimeObjects: ObjectGripAdapter[] = [];
	
	private frames: FrameAdapter[] = [];
	private scopes: ScopeAdapter[] = [];
	
	public constructor(id: number, actor: ThreadActorProxy, debugSession: FirefoxDebugSession) {
		this.id = id;
		this.actor = actor;
		this._debugSession = debugSession;
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

	public registerScope(scopeAdapter: ScopeAdapter) {
		this.scopes.push(scopeAdapter);
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
	
	public fetchStackFrames(): Promise<FrameAdapter[]> {

		return this.actor.fetchStackFrames().then((frames) => 
			frames.map((frame) => {
				let frameAdapter = new FrameAdapter(frame, this);
				this._debugSession.registerFrameAdapter(frameAdapter);
				this.frames.push(frameAdapter);
				return frameAdapter;
			})
		);
	}
	
	public evaluate(expression: string, frameAdapter: FrameAdapter): Promise<FirefoxDebugProtocol.Grip> {
		return this.actor.evaluate(expression, frameAdapter.frame.actor);
	}
}
