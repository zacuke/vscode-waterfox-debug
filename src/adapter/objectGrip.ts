import { ThreadAdapter, VariablesProvider, VariableAdapter } from './index';
import { ObjectGripActorProxy } from '../firefox/index';

export class ObjectGripAdapter implements VariablesProvider {

	public variablesProviderId: number;
	public readonly actor: ObjectGripActorProxy;
	public get threadAdapter(): ThreadAdapter {
		return this.variableAdapter.threadAdapter;
	}

	public constructor(
		private readonly variableAdapter: VariableAdapter,
		objectGrip: FirefoxDebugProtocol.ObjectGrip,
		public readonly threadLifetime: boolean
	) {

		this.actor = this.threadAdapter.debugSession.getOrCreateObjectGripActorProxy(objectGrip);

		this.threadAdapter.debugSession.registerVariablesProvider(this);
	}

	/**
	 * get the referenced object's properties and its prototype as an array of Variables.
	 * This method can only be called when the thread is paused.
	 */
	public async getVariables(): Promise<VariableAdapter[]> {

		let prototypeAndProperties = await this.actor.fetchPrototypeAndProperties();

		let variables: VariableAdapter[] = [];
		let safeGetterValues = prototypeAndProperties.safeGetterValues || {};

		for (let varname in prototypeAndProperties.ownProperties) {
			if (!safeGetterValues[varname]) {
				variables.push(VariableAdapter.fromPropertyDescriptor(
					varname, this.variableAdapter.referenceExpression,
					prototypeAndProperties.ownProperties[varname],
					this.threadLifetime, this.threadAdapter));
			}
		}

		for (let varname in safeGetterValues) {
			variables.push(VariableAdapter.fromSafeGetterValueDescriptor(
				varname, this.variableAdapter.referenceExpression,
				safeGetterValues[varname],
				this.threadLifetime, this.threadAdapter));
		}

		VariableAdapter.sortVariables(variables);

		if (prototypeAndProperties.prototype.type !== 'null') {
			variables.push(VariableAdapter.fromGrip(
				'__proto__', this.variableAdapter.referenceExpression,
				prototypeAndProperties.prototype,
				this.threadLifetime, this.threadAdapter));
		}

		return variables;
	}

	public dispose(): void {
		this.threadAdapter.debugSession.unregisterVariablesProvider(this);
		this.actor.dispose();
	}
}

