import { FirefoxDebugSession } from '../firefoxDebugSession';
import { ScopeAdapter, ObjectScopeAdapter, LocalVariablesScopeAdapter, FunctionArgumentsScopeAdapter } from './scope';

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
	
	public getScopes(debugSession: FirefoxDebugSession): ScopeAdapter[] {
		let scopes = this.getOwnScopes(debugSession);
		if (this.parent !== undefined) {
			scopes = scopes.concat(this.parent.getScopes(debugSession));
		}
		return scopes;
	}
	
	protected abstract getOwnScopes(debugSession: FirefoxDebugSession): ScopeAdapter[];
}

export class ObjectEnvironmentAdapter extends EnvironmentAdapter {
	
	public environment: FirefoxDebugProtocol.ObjectEnvironment;
	
	public constructor(environment: FirefoxDebugProtocol.ObjectEnvironment) {
		super(environment);
	}
	
	protected getOwnScopes(debugSession: FirefoxDebugSession): ScopeAdapter[] {
		let objectGrip = this.environment.object;
		if ((typeof objectGrip === 'boolean') || (typeof objectGrip === 'number') || (typeof objectGrip === 'string')) {
			//TODO this shouldn't happen(?)
			return [];
		} else if (objectGrip.type !== 'object') {
			//TODO this also shouldn't happen(?)
			return [];
		} else {
			return [ new ObjectScopeAdapter('Some object scope', <FirefoxDebugProtocol.ObjectGrip>objectGrip, debugSession) ];
		}
	}
}

export class FunctionEnvironmentAdapter extends EnvironmentAdapter {

	public environment: FirefoxDebugProtocol.FunctionEnvironment;
	
	public constructor(environment: FirefoxDebugProtocol.FunctionEnvironment) {
		super(environment);
	}
	
	protected getOwnScopes(debugSession: FirefoxDebugSession): ScopeAdapter[] {
		return [
			new LocalVariablesScopeAdapter('Some local variables', this.environment.bindings.variables, debugSession),
			new FunctionArgumentsScopeAdapter('Some function arguments', this.environment.bindings.arguments, debugSession)
		];
	}
}

export class WithEnvironmentAdapter extends EnvironmentAdapter {

	public environment: FirefoxDebugProtocol.WithEnvironment;
	
	public constructor(environment: FirefoxDebugProtocol.WithEnvironment) {
		super(environment);
	}
	
	protected getOwnScopes(debugSession: FirefoxDebugSession): ScopeAdapter[] {
		//TODO this is the same as in ObjectEnvironmentAdapter...
		let objectGrip = this.environment.object;
		if ((typeof objectGrip === 'boolean') || (typeof objectGrip === 'number') || (typeof objectGrip === 'string')) {
			//TODO this shouldn't happen(?)
			return [];
		} else if (objectGrip.type !== 'object') {
			//TODO this also shouldn't happen(?)
			return [];
		} else {
			return [ new ObjectScopeAdapter('Some object scope', <FirefoxDebugProtocol.ObjectGrip>objectGrip, debugSession) ];
		}
	}
}

export class BlockEnvironmentAdapter extends EnvironmentAdapter {

	public environment: FirefoxDebugProtocol.BlockEnvironment;
	
	public constructor(environment: FirefoxDebugProtocol.BlockEnvironment) {
		super(environment);
	}
	
	protected getOwnScopes(debugSession: FirefoxDebugSession): ScopeAdapter[] {
		return [ new LocalVariablesScopeAdapter('Some local variables', this.environment.bindings.variables, debugSession) ];
	}
}
