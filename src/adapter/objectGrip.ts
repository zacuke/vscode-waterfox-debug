import { ThreadAdapter, VariablesProvider, VariableAdapter } from './index';
import { ObjectGripActorProxy } from '../firefox/index';
import { Variable } from 'vscode-debugadapter';

export class ObjectGripAdapter implements VariablesProvider {
	
	public isThreadLifetime: boolean;
	public variablesProviderId: number;
	public get actorName(): string {
		return this.actor.name;
	}
	
	private threadAdapter: ThreadAdapter;
	private actor: ObjectGripActorProxy;

	public constructor(objectGrip: FirefoxDebugProtocol.ObjectGrip, threadLifetime: boolean, threadAdapter: ThreadAdapter) {

		this.threadAdapter = threadAdapter;
		this.actor = threadAdapter.debugSession.getOrCreateObjectGripActorProxy(objectGrip);
		this.isThreadLifetime = threadLifetime;

		this.threadAdapter.debugSession.registerVariablesProvider(this);
	}

	public getVariables(): Promise<Variable[]> {

		return this.threadAdapter.actor.runOnPausedThread((finished) => 

			this.actor.fetchPrototypeAndProperties().then(
				(prototypeAndProperties) => {

					let variables: Variable[] = [];
					
					for (let varname in prototypeAndProperties.ownProperties) {
						variables.push(VariableAdapter.getVariableFromPropertyDescriptor(varname, 
							prototypeAndProperties.ownProperties[varname], this.isThreadLifetime, this.threadAdapter));
					}
					
					for (let varname in prototypeAndProperties.safeGetterValues) {
						variables.push(VariableAdapter.getVariableFromSafeGetterValueDescriptor(varname, 
							prototypeAndProperties.safeGetterValues[varname], this.isThreadLifetime, this.threadAdapter));
					}

					VariableAdapter.sortVariables(variables);
					
					if (prototypeAndProperties.prototype !== null)
						variables.push(VariableAdapter.getVariableFromGrip('[prototype]', prototypeAndProperties.prototype, this.isThreadLifetime, this.threadAdapter));
			
					finished();

					return variables;
				},
				(err) => {
					finished();
				})
		);
	}
	
	public dispose(): void {
		this.threadAdapter.debugSession.unregisterVariablesProvider(this);
		this.actor.dispose();
	}
}

