import { ThreadAdapter, VariablesProvider, VariableAdapter, FrameAdapter } from './index';
import { ObjectGripActorProxy } from '../firefox/index';

export class ObjectGripAdapter implements VariablesProvider {

	public readonly variablesProviderId: number;
	public readonly actor: ObjectGripActorProxy;
	public get threadAdapter(): ThreadAdapter {
		return this.variableAdapter.threadAdapter;
	}
	public get referenceExpression(): string | undefined {
		return this.variableAdapter.referenceExpression;
	}
	public get referenceFrame(): FrameAdapter | undefined {
		return this.variableAdapter.referenceFrame;
	}

	public constructor(
		private readonly variableAdapter: VariableAdapter,
		objectGrip: FirefoxDebugProtocol.ObjectGrip,
		public readonly threadLifetime: boolean
	) {
		this.actor = this.threadAdapter.debugAdapter.getOrCreateObjectGripActorProxy(objectGrip);
		this.actor.increaseRefCount();
		this.variablesProviderId = this.threadAdapter.debugAdapter.variablesProviders.register(this);
		this.threadAdapter.registerObjectGripAdapter(this);
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
					varname, this.referenceExpression, this.referenceFrame,
					prototypeAndProperties.ownProperties[varname],
					this.threadLifetime, this.threadAdapter));
			}
		}

		for (let varname in safeGetterValues) {
			variables.push(VariableAdapter.fromSafeGetterValueDescriptor(
				varname, this.referenceExpression, this.referenceFrame,
				safeGetterValues[varname],
				this.threadLifetime, this.threadAdapter));
		}

		VariableAdapter.sortVariables(variables);

		if (prototypeAndProperties.prototype.type !== 'null') {
			variables.push(VariableAdapter.fromGrip(
				'__proto__', this.referenceExpression, this.referenceFrame,
				prototypeAndProperties.prototype,
				this.threadLifetime, this.threadAdapter));
		}

		return variables;
	}

	public dispose(): void {
		this.actor.decreaseRefCount();
		this.threadAdapter.debugAdapter.variablesProviders.unregister(this.variablesProviderId);
	}
}

