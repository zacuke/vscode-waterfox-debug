import { FirefoxDebugSession } from '../firefoxDebugSession';
import { ObjectGripActorProxy } from '../firefox/index';
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
				vars.unshift(getVariableFromGrip('this', this.that, debugSession));
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
		this.objectGripAdapter = new ObjectGripAdapter(object, debugSession);
	}
	
	protected getVariablesInt(debugSession: FirefoxDebugSession): Promise<Variable[]> {
		
		return this.objectGripAdapter.getVariables(debugSession);

	}
}

export class ObjectGripAdapter implements VariablesProvider {
	
	private objectGripActor: ObjectGripActorProxy;
	public variablesProviderId: number;

	public constructor(object: FirefoxDebugProtocol.ObjectGrip, debugSession: FirefoxDebugSession) {
		this.objectGripActor = debugSession.createObjectGripActorProxy(object);
		debugSession.registerVariablesProvider(this);
	}

	public getVariables(debugSession: FirefoxDebugSession): Promise<Variable[]> {

		return this.objectGripActor.fetchPrototypeAndProperties().then((prototypeAndProperties) => {

			let variables: Variable[] = [];
			
			for (let varname in prototypeAndProperties.ownProperties) {
				variables.push(getVariableFromPropertyDescriptor(varname, 
					prototypeAndProperties.ownProperties[varname], debugSession));
			}
			
			for (let varname in prototypeAndProperties.safeGetterValues) {
				variables.push(getVariableFromSafeGetterValueDescriptor(varname, 
					prototypeAndProperties.safeGetterValues[varname], debugSession));
			}

			variables.sort((var1, var2) => compareStrings(var1.name, var2.name));
			
			if (prototypeAndProperties.prototype !== null)
				variables.push(getVariableFromGrip('[prototype]', prototypeAndProperties.prototype, debugSession));
			
			return variables;
		});
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
			variables.push(getVariableFromPropertyDescriptor(varname, this.variables[varname], debugSession));
		}
		
		variables.sort((var1, var2) => compareStrings(var1.name, var2.name));
				
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
				variables.push(getVariableFromPropertyDescriptor(varname, arg[varname], debugSession));
			}
		});
		
		for (let varname in this.bindings.variables) {
			variables.push(getVariableFromPropertyDescriptor(varname, this.bindings.variables[varname], debugSession));
		}

		variables.sort((var1, var2) => compareStrings(var1.name, var2.name));
				
		return Promise.resolve(variables);
	}
}

function getVariableFromPropertyDescriptor(varname: string, propertyDescriptor: FirefoxDebugProtocol.PropertyDescriptor, 
	debugSession: FirefoxDebugSession): Variable {
		
	if ((<FirefoxDebugProtocol.DataPropertyDescriptor>propertyDescriptor).value !== undefined) {
		return getVariableFromGrip(varname, (<FirefoxDebugProtocol.DataPropertyDescriptor>propertyDescriptor).value, debugSession);
	} else {
		return new Variable(varname, 'unknown');
	}
}

function getVariableFromSafeGetterValueDescriptor(varname: string, 
	safeGetterValueDescriptor: FirefoxDebugProtocol.SafeGetterValueDescriptor, debugSession: FirefoxDebugSession): Variable {

	return getVariableFromGrip(varname, safeGetterValueDescriptor.getterValue, debugSession);	
}

export function getVariableFromGrip(varname: string, grip: FirefoxDebugProtocol.Grip, debugSession: FirefoxDebugSession): Variable {

	if ((typeof grip === 'boolean') || (typeof grip === 'number')) {

		return new Variable(varname, grip.toString());

	} else if (typeof grip === 'string') {

		return new Variable(varname, `"${grip}"`);

	} else {

		switch (grip.type) {

			case 'null':
			case 'undefined':
			case 'Infinity':
			case '-Infinity':
			case 'NaN':
			case '-0':

				return new Variable(varname, grip.type);

			case 'longString':

				return new Variable(varname, (<FirefoxDebugProtocol.LongStringGrip>grip).initial);

			case 'object':

				let objectGrip = <FirefoxDebugProtocol.ObjectGrip>grip;
				let vartype = objectGrip.class;
				let variablesProvider = new ObjectGripAdapter(objectGrip, debugSession);
				return new Variable(varname, vartype, variablesProvider.variablesProviderId);

		}
	}
}

function compareStrings(s1: string, s2: string): number {
	if (s1 < s2) {
		return -1;
	} else if (s1 == s2) {
		return 0;
	} else {
		return 1;
	}
}