import { Log } from '../util/log';
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
		
		let grip = this.environment.object;
		
		if ((typeof grip === 'boolean') || (typeof grip === 'number') || (typeof grip === 'string')) {

			Log.error(`Object environment with unexpected grip of type ${typeof grip}`);
			return [];

		} else if (grip.type !== 'object') {

			Log.error(`Object environment with unexpected grip of type ${grip.type}`);
			return [];

		} else {

			let objectGrip = <FirefoxDebugProtocol.ObjectGrip>grip;
			let name = `Object: ${objectGrip.class}`;
			return [ new ObjectScopeAdapter(name, objectGrip, debugSession) ];

		}
	}
}

export class FunctionEnvironmentAdapter extends EnvironmentAdapter {

	public environment: FirefoxDebugProtocol.FunctionEnvironment;
	
	public constructor(environment: FirefoxDebugProtocol.FunctionEnvironment) {
		super(environment);
	}
	
	protected getOwnScopes(debugSession: FirefoxDebugSession): ScopeAdapter[] {

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

		return [
			new LocalVariablesScopeAdapter(`Local: ${funcName}`, this.environment.bindings.variables, debugSession),
			new FunctionArgumentsScopeAdapter(`Arguments: ${funcName}`, this.environment.bindings.arguments, debugSession)
		];
	}
}

export class WithEnvironmentAdapter extends EnvironmentAdapter {

	public environment: FirefoxDebugProtocol.WithEnvironment;
	
	public constructor(environment: FirefoxDebugProtocol.WithEnvironment) {
		super(environment);
	}
	
	protected getOwnScopes(debugSession: FirefoxDebugSession): ScopeAdapter[] {
		
		let grip = this.environment.object;
		
		if ((typeof grip === 'boolean') || (typeof grip === 'number') || (typeof grip === 'string')) {

			Log.error(`"with" environment with unexpected grip of type ${typeof grip}`);
			return [];

		} else if (grip.type !== 'object') {

			Log.error(`"with" environment with unexpected grip of type ${grip.type}`);
			return [];

		} else {

			let objectGrip = <FirefoxDebugProtocol.ObjectGrip>grip;
			let name = `With: ${objectGrip.class}`;
			return [ new ObjectScopeAdapter(name, objectGrip, debugSession) ];

		}
	}
}

export class BlockEnvironmentAdapter extends EnvironmentAdapter {

	public environment: FirefoxDebugProtocol.BlockEnvironment;
	
	public constructor(environment: FirefoxDebugProtocol.BlockEnvironment) {
		super(environment);
	}
	
	protected getOwnScopes(debugSession: FirefoxDebugSession): ScopeAdapter[] {

		return [ new LocalVariablesScopeAdapter('Block', this.environment.bindings.variables, debugSession) ];

	}
}
