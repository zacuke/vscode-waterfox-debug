import { ThreadAdapter, ObjectGripAdapter, VariableAdapter } from './index';
import { Scope, Variable } from 'vscode-debugadapter';

export interface VariablesProvider {
	variablesProviderId: number;
	getVariables(): Promise<Variable[]>;
}

export abstract class ScopeAdapter implements VariablesProvider {
	
	public name: string;
	public variablesProviderId: number;
	public that: FirefoxDebugProtocol.Grip;
	public isTopScope = false;

	protected threadAdapter: ThreadAdapter;
	
	public constructor(name: string, threadAdapter: ThreadAdapter) {
		this.threadAdapter = threadAdapter;
		this.name = name;
		this.threadAdapter.registerScopeAdapter(this);
		this.threadAdapter.debugSession.registerVariablesProvider(this);
	}
	
	public addThis(that: FirefoxDebugProtocol.Grip) {
		this.that = that;
		this.isTopScope = true;
	}
	
	public getScope(): Scope {
		return new Scope(this.name, this.variablesProviderId);
	}
	
	public getVariables(): Promise<Variable[]> {
		
		let variablesPromise = this.getVariablesInt();
		
		if (this.isTopScope) {
			variablesPromise = variablesPromise.then((vars) => {
				vars.unshift(VariableAdapter.getVariableFromGrip('this', this.that, false, this.threadAdapter));
				return vars;
			});
		}
		
		return variablesPromise;
	}
	
	protected abstract getVariablesInt(): Promise<Variable[]>;
	
	public dispose(): void {
		this.threadAdapter.debugSession.unregisterVariablesProvider(this);
	}
}

export class ObjectScopeAdapter extends ScopeAdapter {
	
	private objectGripAdapter: ObjectGripAdapter;
	
	public constructor(name: string, object: FirefoxDebugProtocol.ObjectGrip, threadAdapter: ThreadAdapter) {
		super(name, threadAdapter);
		this.objectGripAdapter = threadAdapter.getOrCreateObjectGripAdapter(object, false);
	}
	
	protected getVariablesInt(): Promise<Variable[]> {
		
		return this.objectGripAdapter.getVariables();

	}
}

export class LocalVariablesScopeAdapter extends ScopeAdapter {
	
	public name: string;
	public variables: FirefoxDebugProtocol.PropertyDescriptors;
	
	public constructor(name: string, variables: FirefoxDebugProtocol.PropertyDescriptors, threadAdapter: ThreadAdapter) {
		super(name, threadAdapter);
		this.variables = variables;
	}
	
	protected getVariablesInt(): Promise<Variable[]> {
		
		let variables: Variable[] = [];
		for (let varname in this.variables) {
			variables.push(VariableAdapter.getVariableFromPropertyDescriptor(varname, this.variables[varname], false, this.threadAdapter));
		}
		
		VariableAdapter.sortVariables(variables);
			
		return Promise.resolve(variables);
	}
}

export class FunctionScopeAdapter extends ScopeAdapter {
	
	public name: string;
	public bindings: FirefoxDebugProtocol.FunctionBindings;
	
	public constructor(name: string, bindings: FirefoxDebugProtocol.FunctionBindings, threadAdapter: ThreadAdapter) {
		super(name, threadAdapter);
		this.bindings = bindings;
	}
	
	protected getVariablesInt(): Promise<Variable[]> {

		let variables: Variable[] = [];
		
		this.bindings.arguments.forEach((arg) => {
			for (let varname in arg) {
				variables.push(VariableAdapter.getVariableFromPropertyDescriptor(varname, arg[varname], false, this.threadAdapter));
			}
		});
		
		for (let varname in this.bindings.variables) {
			variables.push(VariableAdapter.getVariableFromPropertyDescriptor(varname, this.bindings.variables[varname], false, this.threadAdapter));
		}

		VariableAdapter.sortVariables(variables);
				
		return Promise.resolve(variables);
	}
}
