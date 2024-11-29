import { Log } from '../util/log';
import { ScopeAdapter, ObjectScopeAdapter, LocalVariablesScopeAdapter, FunctionScopeAdapter } from './scope';
import { FrameAdapter } from './frame';

let log = Log.create('EnvironmentAdapter');

/**
 * Abstract adapter base class for a lexical environment.
 * Used to create [`ScopeAdapter`](./scope.ts)s which then create `Scope` objects for VS Code.
 */
export abstract class EnvironmentAdapter<T extends WaterfoxDebugProtocol.Environment> {

	protected environment: T;
	protected parent?: EnvironmentAdapter<WaterfoxDebugProtocol.Environment>;

	public constructor(environment: T) {
		this.environment = environment;
		if (environment.parent !== undefined) {
			this.parent = EnvironmentAdapter.from(environment.parent);
		}
	}

	/** factory function for creating an EnvironmentAdapter of the appropriate type */
	public static from(environment: WaterfoxDebugProtocol.Environment): EnvironmentAdapter<WaterfoxDebugProtocol.Environment> {
		switch (environment.type) {
			case 'object':
				return new ObjectEnvironmentAdapter(<WaterfoxDebugProtocol.ObjectEnvironment>environment);
			case 'function':
				return new FunctionEnvironmentAdapter(<WaterfoxDebugProtocol.FunctionEnvironment>environment);
			case 'with':
				return new WithEnvironmentAdapter(<WaterfoxDebugProtocol.WithEnvironment>environment);
			case 'block':
				return new BlockEnvironmentAdapter(<WaterfoxDebugProtocol.BlockEnvironment>environment);
			default:
				throw new Error(`Unknown environment type ${environment.type}`);
		}
	}

	public getScopeAdapters(frameAdapter: FrameAdapter): ScopeAdapter[] {

		let scopes = this.getAllScopeAdapters(frameAdapter);

		return scopes;
	}

	protected getAllScopeAdapters(frameAdapter: FrameAdapter): ScopeAdapter[] {

		let scopes: ScopeAdapter[];

		if (this.parent !== undefined) {
			scopes = this.parent.getAllScopeAdapters(frameAdapter);
		} else {
			scopes = [];
		}

		let ownScope = this.getOwnScopeAdapter(frameAdapter);
		scopes.unshift(ownScope);

		return scopes;
	}

	protected abstract getOwnScopeAdapter(frameAdapter: FrameAdapter): ScopeAdapter;
}

export class ObjectEnvironmentAdapter extends EnvironmentAdapter<WaterfoxDebugProtocol.ObjectEnvironment> {

	public constructor(environment: WaterfoxDebugProtocol.ObjectEnvironment) {
		super(environment);
	}

	protected getOwnScopeAdapter(frameAdapter: FrameAdapter): ScopeAdapter {

		let grip = this.environment.object;

		if ((typeof grip === 'boolean') || (typeof grip === 'number') || (typeof grip === 'string')) {

			throw new Error(`Object environment with unexpected grip of type ${typeof grip}`);

		} else if (grip.type !== 'object') {

			throw new Error(`Object environment with unexpected grip of type ${grip.type}`);

		} else {

			let objectGrip = <WaterfoxDebugProtocol.ObjectGrip>grip;
			let name = `Object: ${objectGrip.class}`;
			return new ObjectScopeAdapter(name, objectGrip, frameAdapter);

		}
	}
}

export class FunctionEnvironmentAdapter extends EnvironmentAdapter<WaterfoxDebugProtocol.FunctionEnvironment> {

	public constructor(environment: WaterfoxDebugProtocol.FunctionEnvironment) {
		super(environment);
	}

	protected getOwnScopeAdapter(frameAdapter: FrameAdapter): ScopeAdapter {

		let funcName = this.environment.function.displayName;
		let scopeName: string;
		if (funcName) {
			scopeName = `Local: ${funcName}`;
		} else {
			log.error(`Unexpected function in function environment: ${JSON.stringify(this.environment.function)}`);
			scopeName = '[unknown]';
		}

		return new FunctionScopeAdapter(scopeName, this.environment.bindings, frameAdapter);
	}
}

export class WithEnvironmentAdapter extends EnvironmentAdapter<WaterfoxDebugProtocol.WithEnvironment> {

	public constructor(environment: WaterfoxDebugProtocol.WithEnvironment) {
		super(environment);
	}

	protected getOwnScopeAdapter(frameAdapter: FrameAdapter): ScopeAdapter {

		let grip = this.environment.object;

		if ((typeof grip === 'boolean') || (typeof grip === 'number') || (typeof grip === 'string')) {

			throw new Error(`"with" environment with unexpected grip of type ${typeof grip}`);

		} else if (grip.type !== 'object') {

			throw new Error(`"with" environment with unexpected grip of type ${grip.type}`);

		} else {

			let objectGrip = <WaterfoxDebugProtocol.ObjectGrip>grip;
			let name = `With: ${objectGrip.class}`;
			return new ObjectScopeAdapter(name, objectGrip, frameAdapter);

		}
	}
}

export class BlockEnvironmentAdapter extends EnvironmentAdapter<WaterfoxDebugProtocol.BlockEnvironment> {

	public constructor(environment: WaterfoxDebugProtocol.BlockEnvironment) {
		super(environment);
	}

	protected getOwnScopeAdapter(frameAdapter: FrameAdapter): ScopeAdapter {

		return new LocalVariablesScopeAdapter('Block', this.environment.bindings.variables, frameAdapter);

	}
}
