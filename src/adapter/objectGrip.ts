import { ThreadAdapter, VariablesProvider, VariableAdapter } from './index';
import { ObjectGripActorProxy } from '../firefox/index';
import { Variable } from 'vscode-debugadapter';

export class ObjectGripAdapter implements VariablesProvider {
	
	public isThreadLifetime: boolean;
	public variablesProviderId: number;
	public threadAdapter: ThreadAdapter;
	public get actor(): ObjectGripActorProxy {
		return this._actor;
	}
	
	private _actor: ObjectGripActorProxy;

	public constructor(objectGrip: FirefoxDebugProtocol.ObjectGrip, threadLifetime: boolean, threadAdapter: ThreadAdapter) {

		this.threadAdapter = threadAdapter;
		this._actor = threadAdapter.debugSession.getOrCreateObjectGripActorProxy(objectGrip);
		this.isThreadLifetime = threadLifetime;

		this.threadAdapter.debugSession.registerVariablesProvider(this);
	}

	/**
	 * get the referenced object's properties and its prototype as an array of Variables.
	 * This method can only be called when the thread is paused.
	 */
	public async getVariables(): Promise<VariableAdapter[]> {

		let prototypeAndProperties = await this.actor.fetchPrototypeAndProperties();

		let variables: VariableAdapter[] = [];

		for (let varname in prototypeAndProperties.ownProperties) {
			variables.push(VariableAdapter.fromPropertyDescriptor(varname,
				prototypeAndProperties.ownProperties[varname], this.isThreadLifetime, this.threadAdapter));
		}

		if (prototypeAndProperties.safeGetterValues) {
			for (let varname in prototypeAndProperties.safeGetterValues) {
				variables.push(VariableAdapter.fromSafeGetterValueDescriptor(varname, 
					prototypeAndProperties.safeGetterValues[varname], this.isThreadLifetime, this.threadAdapter));
			}
		}

		VariableAdapter.sortVariables(variables);

		if (prototypeAndProperties.prototype.type !== 'null') {
			variables.push(VariableAdapter.fromGrip('__proto__', 
				prototypeAndProperties.prototype, this.isThreadLifetime, this.threadAdapter));
		}

		return variables;
	}

	public dispose(): void {
		this.threadAdapter.debugSession.unregisterVariablesProvider(this);
		this.actor.dispose();
	}
}

