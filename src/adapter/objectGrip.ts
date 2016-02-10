import { VariablesProvider, VariableAdapter } from './index';
import { ObjectGripActorProxy } from '../firefox/index';
import { FirefoxDebugSession } from '../firefoxDebugSession';
import { Variable } from 'vscode-debugadapter';

export class ObjectGripAdapter implements VariablesProvider {
	
	private objectGripActor: ObjectGripActorProxy;
	public isThreadLifetime: boolean;
	public variablesProviderId: number;

	public constructor(object: FirefoxDebugProtocol.ObjectGrip, extendLifetime: boolean, debugSession: FirefoxDebugSession) {
		this.objectGripActor = debugSession.createObjectGripActorProxy(object);
		this.isThreadLifetime = extendLifetime;
		if (extendLifetime) {
			this.objectGripActor.extendLifetime();
		}
		debugSession.registerVariablesProvider(this);
	}

	public getVariables(debugSession: FirefoxDebugSession): Promise<Variable[]> {

		return this.objectGripActor.fetchPrototypeAndProperties().then((prototypeAndProperties) => {

			let variables: Variable[] = [];
			
			for (let varname in prototypeAndProperties.ownProperties) {
				variables.push(VariableAdapter.getVariableFromPropertyDescriptor(varname, 
					prototypeAndProperties.ownProperties[varname], this.isThreadLifetime, debugSession));
			}
			
			for (let varname in prototypeAndProperties.safeGetterValues) {
				variables.push(VariableAdapter.getVariableFromSafeGetterValueDescriptor(varname, 
					prototypeAndProperties.safeGetterValues[varname], this.isThreadLifetime, debugSession));
			}

			VariableAdapter.sortVariables(variables);
			
			if (prototypeAndProperties.prototype !== null)
				variables.push(VariableAdapter.getVariableFromGrip('[prototype]', prototypeAndProperties.prototype, this.isThreadLifetime, debugSession));
			
			return variables;
		});
	}
}

