import { Log } from '../util/log';
import { FirefoxDebugSession } from '../firefoxDebugSession';
import { ScopeAdapter, ObjectScopeAdapter, LocalVariablesScopeAdapter, FunctionScopeAdapter } from './scope';

export abstract class EnvironmentAdapter {
	
	public environment: FirefoxDebugProtocol.Environment;
	public parent: EnvironmentAdapter;
	
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
	
	public getScopeAdapters(debugSession: FirefoxDebugSession, that: FirefoxDebugProtocol.Grip): ScopeAdapter[] {

		let scopes = this.getAllScopeAdapters(debugSession);
		
		return scopes;
	}
	
	protected getAllScopeAdapters(debugSession: FirefoxDebugSession): ScopeAdapter[] {
		
		let scopes: ScopeAdapter[];
		
		if (this.parent !== undefined) {
			scopes = this.parent.getAllScopeAdapters(debugSession);
		} else {
			scopes = [];
		}
		
		let ownScope = this.getOwnScopeAdapter(debugSession);
		if (ownScope != null) {
			scopes.unshift(ownScope);
		}
		
		return scopes;
	}
	
	protected abstract getOwnScopeAdapter(debugSession: FirefoxDebugSession): ScopeAdapter;
}

export class ObjectEnvironmentAdapter extends EnvironmentAdapter {
	
	public environment: FirefoxDebugProtocol.ObjectEnvironment;
	
	public constructor(environment: FirefoxDebugProtocol.ObjectEnvironment) {
		super(environment);
	}
	
	protected getOwnScopeAdapter(debugSession: FirefoxDebugSession): ScopeAdapter {
		
		let grip = this.environment.object;
		
		if ((typeof grip === 'boolean') || (typeof grip === 'number') || (typeof grip === 'string')) {

			Log.error(`Object environment with unexpected grip of type ${typeof grip}`);
			return null;

		} else if (grip.type !== 'object') {

			Log.error(`Object environment with unexpected grip of type ${grip.type}`);
			return null;

		} else {

			let objectGrip = <FirefoxDebugProtocol.ObjectGrip>grip;
			let name = `Object: ${objectGrip.class}`;
			return new ObjectScopeAdapter(name, objectGrip, debugSession);

		}
	}
}

export class FunctionEnvironmentAdapter extends EnvironmentAdapter {

	public environment: FirefoxDebugProtocol.FunctionEnvironment;
	
	public constructor(environment: FirefoxDebugProtocol.FunctionEnvironment) {
		super(environment);
	}
	
	protected getOwnScopeAdapter(debugSession: FirefoxDebugSession): ScopeAdapter {

		let func = this.environment.function;
		let funcName: string;
		if ((typeof func === 'object') && (func.type === 'object') && 
			((<FirefoxDebugProtocol.ObjectGrip>func).class === 'Function') &&
			((<FirefoxDebugProtocol.FunctionGrip>func).name !== undefined)) {
				
			funcName = (<FirefoxDebugProtocol.FunctionGrip>func).name;

		} else {

			Log.error(`Unexpected function grip in function environment: ${JSON.stringify(func)}`);
			funcName = '[unknown]';

		}

		return new FunctionScopeAdapter(`Local: ${funcName}`, this.environment.bindings, debugSession);
	}
}

export class WithEnvironmentAdapter extends EnvironmentAdapter {

	public environment: FirefoxDebugProtocol.WithEnvironment;
	
	public constructor(environment: FirefoxDebugProtocol.WithEnvironment) {
		super(environment);
	}
	
	protected getOwnScopeAdapter(debugSession: FirefoxDebugSession): ScopeAdapter {
		
		let grip = this.environment.object;
		
		if ((typeof grip === 'boolean') || (typeof grip === 'number') || (typeof grip === 'string')) {

			Log.error(`"with" environment with unexpected grip of type ${typeof grip}`);
			return null;

		} else if (grip.type !== 'object') {

			Log.error(`"with" environment with unexpected grip of type ${grip.type}`);
			return null;

		} else {

			let objectGrip = <FirefoxDebugProtocol.ObjectGrip>grip;
			let name = `With: ${objectGrip.class}`;
			return new ObjectScopeAdapter(name, objectGrip, debugSession);

		}
	}
}

export class BlockEnvironmentAdapter extends EnvironmentAdapter {

	public environment: FirefoxDebugProtocol.BlockEnvironment;
	
	public constructor(environment: FirefoxDebugProtocol.BlockEnvironment) {
		super(environment);
	}
	
	protected getOwnScopeAdapter(debugSession: FirefoxDebugSession): ScopeAdapter {

		return new LocalVariablesScopeAdapter('Block', this.environment.bindings.variables, debugSession);

	}
}
