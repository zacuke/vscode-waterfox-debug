import { ThreadAdapter, ObjectGripAdapter, VariableAdapter } from './index';
import { Scope, Variable } from 'vscode-debugadapter';

export interface VariablesProvider {
	variablesProviderId: number;
	threadAdapter: ThreadAdapter;
	getVariables(): Promise<VariableAdapter[]>;
}

export abstract class ScopeAdapter implements VariablesProvider {
	
	public name: string;
	public variablesProviderId: number;
	public thisVariable: VariableAdapter;
	public completionVariable: VariableAdapter;
	public threadAdapter: ThreadAdapter;
	
	public constructor(name: string, threadAdapter: ThreadAdapter) {
		this.threadAdapter = threadAdapter;
		this.name = name;
		this.threadAdapter.registerScopeAdapter(this);
		this.threadAdapter.debugSession.registerVariablesProvider(this);
	}
	
	public addThis(thisGrip: FirefoxDebugProtocol.Grip) {
		this.thisVariable = VariableAdapter.fromGrip('this', thisGrip, false, this.threadAdapter);
	}

	public addCompletionValue(completionValue: FirefoxDebugProtocol.CompletionValue) {

		if (completionValue) {

			if (completionValue.return) {
			
				this.completionVariable = VariableAdapter.fromGrip(
					'<return>', completionValue.return, false, this.threadAdapter);
				
			} else if (completionValue.throw) {

				this.completionVariable = VariableAdapter.fromGrip(
					'<exception>', completionValue.throw, false, this.threadAdapter);

			}
		}
	}
	
	public getScope(): Scope {
		return new Scope(this.name, this.variablesProviderId);
	}
	
	public getVariables(): Promise<VariableAdapter[]> {
		
		let variablesPromise = this.getVariablesInt();
		
		if (this.thisVariable) {
			variablesPromise = variablesPromise.then((vars) => {
				vars.unshift(this.thisVariable);
				return vars;
			});
		}
		
		if (this.completionVariable) {
			variablesPromise = variablesPromise.then((vars) => {
				vars.unshift(this.completionVariable);
				return vars;
			});
		}
		
		return variablesPromise;
	}
	
	protected abstract getVariablesInt(): Promise<VariableAdapter[]>;
	
	public getObjectGripAdapters(): ObjectGripAdapter[] {
		
		let objectGripadapters = this.getObjectGripAdaptersInt();
		if (this.thisVariable && this.thisVariable.getObjectGripAdapter()) {
			objectGripadapters.push(this.thisVariable.getObjectGripAdapter());
		}
		if (this.completionVariable && this.completionVariable.getObjectGripAdapter()) {
			objectGripadapters.push(this.completionVariable.getObjectGripAdapter());
		}
		
		return objectGripadapters;
	}
	
	protected abstract getObjectGripAdaptersInt(): ObjectGripAdapter[];
	
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
	
	protected getVariablesInt(): Promise<VariableAdapter[]> {
		return this.objectGripAdapter.getVariables();
	}
	
	protected getObjectGripAdaptersInt(): ObjectGripAdapter[] {
		return [this.objectGripAdapter];
	}
}

export class LocalVariablesScopeAdapter extends ScopeAdapter {
	
	public name: string;
	public variableDescriptors: FirefoxDebugProtocol.PropertyDescriptors;
	public variables: VariableAdapter[] = [];
	
	public constructor(name: string, variableDescriptors: FirefoxDebugProtocol.PropertyDescriptors, threadAdapter: ThreadAdapter) {
		super(name, threadAdapter);
		this.variableDescriptors = variableDescriptors;

		for (let varname in this.variableDescriptors) {
			this.variables.push(VariableAdapter.fromPropertyDescriptor(
				varname, this.variableDescriptors[varname], false, this.threadAdapter));
		}
		
		VariableAdapter.sortVariables(this.variables);
	}
	
	protected getVariablesInt(): Promise<VariableAdapter[]> {
		return Promise.resolve(this.variables);
	}
	
	protected getObjectGripAdaptersInt(): ObjectGripAdapter[] {
		return this.variables
			.map((variableAdapter) => variableAdapter.getObjectGripAdapter())
			.filter((objectGripAdapter) => (objectGripAdapter != null));
	}
}

export class FunctionScopeAdapter extends ScopeAdapter {
	
	public name: string;
	public bindings: FirefoxDebugProtocol.FunctionBindings;
	public variables: VariableAdapter[] = [];
	
	public constructor(name: string, bindings: FirefoxDebugProtocol.FunctionBindings, threadAdapter: ThreadAdapter) {
		super(name, threadAdapter);
		this.bindings = bindings;

		this.bindings.arguments.forEach((arg) => {
			for (let varname in arg) {
				this.variables.push(VariableAdapter.fromPropertyDescriptor(
					varname, arg[varname], false, this.threadAdapter));
			}
		});
		
		for (let varname in this.bindings.variables) {
			this.variables.push(VariableAdapter.fromPropertyDescriptor(
				varname, this.bindings.variables[varname], false, this.threadAdapter));
		}

		VariableAdapter.sortVariables(this.variables);
	}
	
	protected getVariablesInt(): Promise<VariableAdapter[]> {
		return Promise.resolve(this.variables);
	}
	
	protected getObjectGripAdaptersInt(): ObjectGripAdapter[] {
		return this.variables
			.map((variableAdapter) => variableAdapter.getObjectGripAdapter())
			.filter((objectGripAdapter) => (objectGripAdapter != null));
	}
}
