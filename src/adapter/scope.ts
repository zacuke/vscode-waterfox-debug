import { FirefoxDebugSession } from '../firefoxDebugSession';
import { ObjectGripActorProxy } from '../firefox/index';
import { ObjectGripAdapter, VariableAdapter } from './index';
import { Scope, Variable } from 'vscode-debugadapter';

export interface VariablesProvider {
	variablesProviderId: number;
	getVariables(debugSession: FirefoxDebugSession): Promise<Variable[]>;
}

export abstract class ScopeAdapter implements VariablesProvider {
	
	public name: string;
	public variablesProviderId: number;
	public that: FirefoxDebugProtocol.Grip;
	public isTopScope = false;
	
	public constructor(name: string, debugSession: FirefoxDebugSession) {
		this.name = name;
		debugSession.registerVariablesProvider(this);
	}
	
	public addThis(that: FirefoxDebugProtocol.Grip) {
		this.that = that;
		this.isTopScope = true;
	}
	
	public getScope(): Scope {
		return new Scope(this.name, this.variablesProviderId);
	}
	
	public getVariables(debugSession: FirefoxDebugSession): Promise<Variable[]> {
		
		let variablesPromise = this.getVariablesInt(debugSession);
		
		if (this.isTopScope) {
			variablesPromise = variablesPromise.then((vars) => {
				vars.unshift(VariableAdapter.getVariableFromGrip('this', this.that, false, debugSession));
				return vars;
			});
		}
		
		return variablesPromise;
	}
	
	protected abstract getVariablesInt(debugSession: FirefoxDebugSession): Promise<Variable[]>;
}

export class ObjectScopeAdapter extends ScopeAdapter {
	
	private objectGripAdapter: ObjectGripAdapter;
	
	public constructor(name: string, object: FirefoxDebugProtocol.ObjectGrip, debugSession: FirefoxDebugSession) {
		super(name, debugSession);
		this.objectGripAdapter = new ObjectGripAdapter(object, false, debugSession);
	}
	
	protected getVariablesInt(debugSession: FirefoxDebugSession): Promise<Variable[]> {
		
		return this.objectGripAdapter.getVariables(debugSession);

	}
}

export class LocalVariablesScopeAdapter extends ScopeAdapter {
	
	public name: string;
	public variables: FirefoxDebugProtocol.PropertyDescriptors;
	
	public constructor(name: string, variables: FirefoxDebugProtocol.PropertyDescriptors, debugSession: FirefoxDebugSession) {
		super(name, debugSession);
		this.variables = variables;
	}
	
	protected getVariablesInt(debugSession: FirefoxDebugSession): Promise<Variable[]> {
		
		let variables: Variable[] = [];
		for (let varname in this.variables) {
			variables.push(VariableAdapter.getVariableFromPropertyDescriptor(varname, this.variables[varname], false, debugSession));
		}
		
		VariableAdapter.sortVariables(variables);
			
		return Promise.resolve(variables);
	}
}

export class FunctionScopeAdapter extends ScopeAdapter {
	
	public name: string;
	public bindings: FirefoxDebugProtocol.FunctionBindings;
	
	public constructor(name: string, bindings: FirefoxDebugProtocol.FunctionBindings, debugSession: FirefoxDebugSession) {
		super(name, debugSession);
		this.bindings = bindings;
	}
	
	protected getVariablesInt(debugSession: FirefoxDebugSession): Promise<Variable[]> {

		let variables: Variable[] = [];
		
		this.bindings.arguments.forEach((arg) => {
			for (let varname in arg) {
				variables.push(VariableAdapter.getVariableFromPropertyDescriptor(varname, arg[varname], false, debugSession));
			}
		});
		
		for (let varname in this.bindings.variables) {
			variables.push(VariableAdapter.getVariableFromPropertyDescriptor(varname, this.bindings.variables[varname], false, debugSession));
		}

		VariableAdapter.sortVariables(variables);
				
		return Promise.resolve(variables);
	}
}
