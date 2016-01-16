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
	
	public constructor(name: string, debugSession: FirefoxDebugSession) {
		this.name = name;
		debugSession.registerVariablesProvider(this);
	}
	
	public getScope(): Scope {
		return new Scope(this.name, this.variablesProviderId);
	}
	
	public abstract getVariables(debugSession: FirefoxDebugSession): Promise<Variable[]>;
}

export class ObjectScopeAdapter extends ScopeAdapter {
	
	public object: FirefoxDebugProtocol.ObjectGrip;
	public objectGripActor: ObjectGripActorProxy;
	
	public constructor(name: string, object: FirefoxDebugProtocol.ObjectGrip, debugSession: FirefoxDebugSession) {
		super(name, debugSession);
		this.object = object;
		this.objectGripActor = debugSession.createObjectGripActorProxy(this.object);
	}
	
	public getVariables(debugSession: FirefoxDebugSession): Promise<Variable[]> {
		
		return this.objectGripActor.fetchPrototypeAndProperties().then((prototypeAndProperties) => {

			let variables: Variable[] = [];
			for (let varname in prototypeAndProperties.ownProperties) {
				variables.push(getVariableFromPropertyDescriptor(varname, prototypeAndProperties.ownProperties[varname], debugSession));
			}
			
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
	
	public getVariables(debugSession: FirefoxDebugSession): Promise<Variable[]> {
		
		let variables: Variable[] = [];
		for (let varname in this.variables) {
			variables.push(getVariableFromPropertyDescriptor(varname, this.variables[varname], debugSession));
		}
		
		return Promise.resolve(variables);
	}
}

export class FunctionArgumentsScopeAdapter extends ScopeAdapter {
	
	public name: string;
	public args: FirefoxDebugProtocol.PropertyDescriptors[];
	
	public constructor(name: string, args: FirefoxDebugProtocol.PropertyDescriptors[], debugSession: FirefoxDebugSession) {
		super(name, debugSession);
		this.args = args;
	}
	
	public getVariables(debugSession: FirefoxDebugSession): Promise<Variable[]> {

		let variables: Variable[] = [];
		this.args.forEach((arg) => {
			for (let varname in arg) {
				variables.push(getVariableFromPropertyDescriptor(varname, arg[varname], debugSession));
			}
		});
		
		return Promise.resolve(variables);
	}
}

function getVariableFromPropertyDescriptor(varname: string, propertyDescriptor: PropertyDescriptor, debugSession: FirefoxDebugSession): Variable {
	if (propertyDescriptor.value !== undefined) {
		return getVariableFromGrip(varname, propertyDescriptor.value, debugSession);
	} else {
		return new Variable(varname, 'unknown');
	}
}

function getVariableFromGrip(varname: string, grip: FirefoxDebugProtocol.Grip, debugSession: FirefoxDebugSession): Variable {
	if ((typeof grip === 'boolean') || (typeof grip === 'number') || (typeof grip === 'string')) {
		return new Variable(varname, <string>grip);
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
				let variablesProvider = new ObjectScopeAdapter(varname, <FirefoxDebugProtocol.ObjectGrip>grip, debugSession);
				return new Variable(varname, '...', variablesProvider.variablesProviderId);
		}
	}
}
