import { ThreadAdapter, ObjectGripAdapter, VariableAdapter } from './index';
import { Scope, Variable } from 'vscode-debugadapter';

export interface VariablesProvider {
	variablesProviderId: number;
	getVariables(): Promise<Variable[]>;
}

export abstract class ScopeAdapter implements VariablesProvider {
	
	public name: string;
	public variablesProviderId: number;
	public thisVariable: Variable;
	public isTopScope = false;

	protected threadAdapter: ThreadAdapter;
	
	public constructor(name: string, threadAdapter: ThreadAdapter) {
		this.threadAdapter = threadAdapter;
		this.name = name;
		this.threadAdapter.registerScopeAdapter(this);
		this.threadAdapter.debugSession.registerVariablesProvider(this);
	}
	
	public addThis(thisGrip: FirefoxDebugProtocol.Grip) {
		this.thisVariable = VariableAdapter.getVariableFromGrip('this', thisGrip, false, this.threadAdapter);
		this.isTopScope = true;
	}
	
	public getScope(): Scope {
		return new Scope(this.name, this.variablesProviderId);
	}
	
	public getVariables(): Promise<Variable[]> {
		
		let variablesPromise = this.getVariablesInt();
		
		if (this.isTopScope) {
			variablesPromise = variablesPromise.then((vars) => {
				vars.unshift(this.thisVariable);
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
	public variableDescriptors: FirefoxDebugProtocol.PropertyDescriptors;
	public variables: Variable[] = [];
	
	public constructor(name: string, variableDescriptors: FirefoxDebugProtocol.PropertyDescriptors, threadAdapter: ThreadAdapter) {
		super(name, threadAdapter);
		this.variableDescriptors = variableDescriptors;

		for (let varname in this.variableDescriptors) {
			this.variables.push(VariableAdapter.getVariableFromPropertyDescriptor(varname, this.variableDescriptors[varname], false, this.threadAdapter));
		}
		
		VariableAdapter.sortVariables(this.variables);
	}
	
	protected getVariablesInt(): Promise<Variable[]> {
		return Promise.resolve(this.variables);
	}
}

export class FunctionScopeAdapter extends ScopeAdapter {
	
	public name: string;
	public bindings: FirefoxDebugProtocol.FunctionBindings;
	public variables: Variable[] = [];
	
	public constructor(name: string, bindings: FirefoxDebugProtocol.FunctionBindings, threadAdapter: ThreadAdapter) {
		super(name, threadAdapter);
		this.bindings = bindings;

		this.bindings.arguments.forEach((arg) => {
			for (let varname in arg) {
				this.variables.push(VariableAdapter.getVariableFromPropertyDescriptor(varname, arg[varname], false, this.threadAdapter));
			}
		});
		
		for (let varname in this.bindings.variables) {
			this.variables.push(VariableAdapter.getVariableFromPropertyDescriptor(varname, this.bindings.variables[varname], false, this.threadAdapter));
		}

		VariableAdapter.sortVariables(this.variables);
	}
	
	protected getVariablesInt(): Promise<Variable[]> {
		return Promise.resolve(this.variables);
	}
}
