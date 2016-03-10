import { Log } from '../util/log';
import { FirefoxDebugSession } from '../firefoxDebugSession';
import { ScopeAdapter, ObjectScopeAdapter, LocalVariablesScopeAdapter, FunctionScopeAdapter } from './scope';
import { ThreadAdapter } from './thread';

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
				return null;
		}
	}
	
	public getScopeAdapters(threadAdapter: ThreadAdapter): ScopeAdapter[] {

		let scopes = this.getAllScopeAdapters(threadAdapter);
		
		return scopes;
	}
	
	protected getAllScopeAdapters(threadAdapter: ThreadAdapter): ScopeAdapter[] {
		
		let scopes: ScopeAdapter[];
		
		if (this.parent !== undefined) {
			scopes = this.parent.getAllScopeAdapters(threadAdapter);
		} else {
			scopes = [];
		}
		
		let ownScope = this.getOwnScopeAdapter(threadAdapter);
		if (ownScope != null) {
			scopes.unshift(ownScope);
		}
		
		return scopes;
	}
	
	protected abstract getOwnScopeAdapter(threadAdapter: ThreadAdapter): ScopeAdapter;
}

export class ObjectEnvironmentAdapter extends EnvironmentAdapter {
	
	protected environment: FirefoxDebugProtocol.ObjectEnvironment;
	
	public constructor(environment: FirefoxDebugProtocol.ObjectEnvironment) {
		super(environment);
	}
	
	protected getOwnScopeAdapter(threadAdapter: ThreadAdapter): ScopeAdapter {
		
		let grip = this.environment.object;
		
		if ((typeof grip === 'boolean') || (typeof grip === 'number') || (typeof grip === 'string')) {

			log.error(`Object environment with unexpected grip of type ${typeof grip}`);
			return null;

		} else if (grip.type !== 'object') {

			log.error(`Object environment with unexpected grip of type ${grip.type}`);
			return null;

		} else {

			let objectGrip = <FirefoxDebugProtocol.ObjectGrip>grip;
			let name = `Object: ${objectGrip.class}`;
			return new ObjectScopeAdapter(name, objectGrip, threadAdapter);

		}
	}
}

export class FunctionEnvironmentAdapter extends EnvironmentAdapter {

	protected environment: FirefoxDebugProtocol.FunctionEnvironment;
	
	public constructor(environment: FirefoxDebugProtocol.FunctionEnvironment) {
		super(environment);
	}
	
	protected getOwnScopeAdapter(threadAdapter: ThreadAdapter): ScopeAdapter {

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

		return new FunctionScopeAdapter(scopeName, this.environment.bindings, threadAdapter);
	}
}

export class WithEnvironmentAdapter extends EnvironmentAdapter {

	protected environment: FirefoxDebugProtocol.WithEnvironment;
	
	public constructor(environment: FirefoxDebugProtocol.WithEnvironment) {
		super(environment);
	}
	
	protected getOwnScopeAdapter(threadAdapter: ThreadAdapter): ScopeAdapter {
		
		let grip = this.environment.object;
		
		if ((typeof grip === 'boolean') || (typeof grip === 'number') || (typeof grip === 'string')) {

			log.error(`"with" environment with unexpected grip of type ${typeof grip}`);
			return null;

		} else if (grip.type !== 'object') {

			log.error(`"with" environment with unexpected grip of type ${grip.type}`);
			return null;

		} else {

			let objectGrip = <FirefoxDebugProtocol.ObjectGrip>grip;
			let name = `With: ${objectGrip.class}`;
			return new ObjectScopeAdapter(name, objectGrip, threadAdapter);

		}
	}
}

export class BlockEnvironmentAdapter extends EnvironmentAdapter {

	protected environment: FirefoxDebugProtocol.BlockEnvironment;
	
	public constructor(environment: FirefoxDebugProtocol.BlockEnvironment) {
		super(environment);
	}
	
	protected getOwnScopeAdapter(threadAdapter: ThreadAdapter): ScopeAdapter {

		return new LocalVariablesScopeAdapter('Block', this.environment.bindings.variables, threadAdapter);

	}
}
