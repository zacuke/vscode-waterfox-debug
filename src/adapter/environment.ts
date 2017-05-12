import { Log } from '../util/log';
import { ScopeAdapter, ObjectScopeAdapter, LocalVariablesScopeAdapter, FunctionScopeAdapter } from './scope';
import { FrameAdapter } from "./frame";

let log = Log.create('EnvironmentAdapter');

export abstract class EnvironmentAdapter {
	
	protected environment: FirefoxDebugProtocol.Environment;
	protected parent: EnvironmentAdapter;
	
	public constructor(environment: FirefoxDebugProtocol.Environment) {
		this.environment = environment;
		if (environment.parent !== undefined) {
			this.parent = EnvironmentAdapter.from(environment.parent);
		}
	}

	public static from(environment: FirefoxDebugProtocol.Environment): EnvironmentAdapter {
		switch (environment.type) {
			case 'object':
				return new ObjectEnvironmentAdapter(<FirefoxDebugProtocol.ObjectEnvironment>environment);
			case 'function':
				return new FunctionEnvironmentAdapter(<FirefoxDebugProtocol.FunctionEnvironment>environment);
			case 'with':
				return new WithEnvironmentAdapter(<FirefoxDebugProtocol.WithEnvironment>environment);
			case 'block':
				return new BlockEnvironmentAdapter(<FirefoxDebugProtocol.BlockEnvironment>environment);
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

export class ObjectEnvironmentAdapter extends EnvironmentAdapter {

	protected environment: FirefoxDebugProtocol.ObjectEnvironment;

	public constructor(environment: FirefoxDebugProtocol.ObjectEnvironment) {
		super(environment);
	}

	protected getOwnScopeAdapter(frameAdapter: FrameAdapter): ScopeAdapter {

		let grip = this.environment.object;
		
		if ((typeof grip === 'boolean') || (typeof grip === 'number') || (typeof grip === 'string')) {

			throw new Error(`Object environment with unexpected grip of type ${typeof grip}`);

		} else if (grip.type !== 'object') {

			throw new Error(`Object environment with unexpected grip of type ${grip.type}`);

		} else {

			let objectGrip = <FirefoxDebugProtocol.ObjectGrip>grip;
			let name = `Object: ${objectGrip.class}`;
			return new ObjectScopeAdapter(name, objectGrip, frameAdapter);

		}
	}
}

export class FunctionEnvironmentAdapter extends EnvironmentAdapter {

	protected environment: FirefoxDebugProtocol.FunctionEnvironment;

	public constructor(environment: FirefoxDebugProtocol.FunctionEnvironment) {
		super(environment);
	}

	protected getOwnScopeAdapter(frameAdapter: FrameAdapter): ScopeAdapter {

		let func = this.environment.function;
		let scopeName: string;
		if ((typeof func === 'object') && (func.type === 'object') && 
			((<FirefoxDebugProtocol.ObjectGrip>func).class === 'Function')) {

			let funcName = (<FirefoxDebugProtocol.FunctionGrip>func).name;
			scopeName = (funcName !== undefined) ? `Local: ${funcName}` : 'Local';

		} else {

			log.error(`Unexpected function grip in function environment: ${JSON.stringify(func)}`);
			scopeName = '[unknown]';

		}

		return new FunctionScopeAdapter(scopeName, this.environment.bindings, frameAdapter);
	}
}

export class WithEnvironmentAdapter extends EnvironmentAdapter {

	protected environment: FirefoxDebugProtocol.WithEnvironment;

	public constructor(environment: FirefoxDebugProtocol.WithEnvironment) {
		super(environment);
	}

	protected getOwnScopeAdapter(frameAdapter: FrameAdapter): ScopeAdapter {

		let grip = this.environment.object;

		if ((typeof grip === 'boolean') || (typeof grip === 'number') || (typeof grip === 'string')) {

			throw new Error(`"with" environment with unexpected grip of type ${typeof grip}`);

		} else if (grip.type !== 'object') {

			throw new Error(`"with" environment with unexpected grip of type ${grip.type}`);

		} else {

			let objectGrip = <FirefoxDebugProtocol.ObjectGrip>grip;
			let name = `With: ${objectGrip.class}`;
			return new ObjectScopeAdapter(name, objectGrip, frameAdapter);

		}
	}
}

export class BlockEnvironmentAdapter extends EnvironmentAdapter {

	protected environment: FirefoxDebugProtocol.BlockEnvironment;

	public constructor(environment: FirefoxDebugProtocol.BlockEnvironment) {
		super(environment);
	}

	protected getOwnScopeAdapter(frameAdapter: FrameAdapter): ScopeAdapter {

		return new LocalVariablesScopeAdapter('Block', this.environment.bindings.variables, frameAdapter);

	}
}
