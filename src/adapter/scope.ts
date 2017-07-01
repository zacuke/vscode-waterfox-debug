import { ThreadAdapter, ObjectGripAdapter, VariableAdapter, FrameAdapter } from './index';
import { Scope } from 'vscode-debugadapter';

export interface VariablesProvider {
	readonly variablesProviderId: number;
	readonly threadAdapter: ThreadAdapter;
	readonly threadLifetime: boolean;
	readonly referenceFrame: FrameAdapter | undefined;
	readonly referenceExpression: string | undefined;
	getVariables(): Promise<VariableAdapter[]>;
}

export abstract class ScopeAdapter implements VariablesProvider {

	public readonly variablesProviderId: number;
	public readonly referenceExpression = '';
	public get threadAdapter(): ThreadAdapter {
		return this.referenceFrame.threadAdapter;
	}

	public thisVariable: VariableAdapter;
	public returnVariable: VariableAdapter;
	public readonly threadLifetime = false;

	protected constructor(
		public readonly name: string,
		public readonly referenceFrame: FrameAdapter
	) {
		this.threadAdapter.registerScopeAdapter(this);
		this.variablesProviderId = this.threadAdapter.debugAdapter.variablesProviders.register(this);
	}

	public static fromGrip(name: string, grip: FirefoxDebugProtocol.Grip, referenceFrame: FrameAdapter): ScopeAdapter {
		if ((typeof grip === 'object') && (grip.type === 'object')) {
			return new ObjectScopeAdapter(name, <FirefoxDebugProtocol.ObjectGrip>grip, referenceFrame);
		} else {
			return new SingleValueScopeAdapter(name, grip, referenceFrame);
		}
	}

	public addThis(thisValue: FirefoxDebugProtocol.Grip) {
		this.thisVariable = VariableAdapter.fromGrip(
			'this', this.referenceExpression, this.referenceFrame, thisValue, false, this.threadAdapter);
	}

	public addReturnValue(returnValue: FirefoxDebugProtocol.Grip) {
		this.returnVariable = VariableAdapter.fromGrip(
			'Return value', undefined, this.referenceFrame, returnValue, false, this.threadAdapter);
	}

	public getScope(): Scope {
		return new Scope(this.name, this.variablesProviderId);
	}

	public async getVariables(): Promise<VariableAdapter[]> {

		let variables = await this.getVariablesInt();

		if (this.thisVariable) {
			variables.unshift(this.thisVariable);
		}

		if (this.returnVariable) {
			variables.unshift(this.returnVariable);
		}

		return variables;
	}

	protected abstract getVariablesInt(): Promise<VariableAdapter[]>;

	public getObjectGripAdapters(): ObjectGripAdapter[] {

		let objectGripadapters = this.getObjectGripAdaptersInt();
		if (this.thisVariable && this.thisVariable.objectGripAdapter) {
			objectGripadapters.push(this.thisVariable.objectGripAdapter);
		}
		if (this.returnVariable && this.returnVariable.objectGripAdapter) {
			objectGripadapters.push(this.returnVariable.objectGripAdapter);
		}

		return objectGripadapters;
	}

	protected abstract getObjectGripAdaptersInt(): ObjectGripAdapter[];

	public dispose(): void {
		this.threadAdapter.debugAdapter.variablesProviders.unregister(this.variablesProviderId);
	}
}

export class SingleValueScopeAdapter extends ScopeAdapter {

	private variableAdapter: VariableAdapter;

	public constructor(name: string, grip: FirefoxDebugProtocol.Grip, referenceFrame: FrameAdapter) {
		super(name, referenceFrame);
		this.variableAdapter = VariableAdapter.fromGrip(
			'', this.referenceExpression, this.referenceFrame, grip, false, this.threadAdapter);
	}

	protected getVariablesInt(): Promise<VariableAdapter[]> {
		return Promise.resolve([this.variableAdapter]);
	}

	protected getObjectGripAdaptersInt(): ObjectGripAdapter[] {
		let objectGripAdapter = this.variableAdapter.objectGripAdapter;
		return (objectGripAdapter === undefined) ? [] : [objectGripAdapter];
	}
}

export class ObjectScopeAdapter extends ScopeAdapter {

	private variableAdapter: VariableAdapter;

	public constructor(name: string, object: FirefoxDebugProtocol.ObjectGrip, referenceFrame: FrameAdapter) {
		super(name, referenceFrame);
		this.variableAdapter = VariableAdapter.fromGrip(
			'', this.referenceExpression, this.referenceFrame, object, false, this.threadAdapter);
	}

	protected getVariablesInt(): Promise<VariableAdapter[]> {
		return this.variableAdapter.objectGripAdapter!.getVariables();
	}

	protected getObjectGripAdaptersInt(): ObjectGripAdapter[] {
		return [this.variableAdapter.objectGripAdapter!];
	}
}

export class LocalVariablesScopeAdapter extends ScopeAdapter {

	public name: string;
	public variables: VariableAdapter[] = [];

	public constructor(name: string, variableDescriptors: FirefoxDebugProtocol.PropertyDescriptors, referenceFrame: FrameAdapter) {
		super(name, referenceFrame);

		for (let varname in variableDescriptors) {
			this.variables.push(VariableAdapter.fromPropertyDescriptor(
				varname, this.referenceExpression, this.referenceFrame,
				variableDescriptors[varname], false, this.threadAdapter));
		}

		VariableAdapter.sortVariables(this.variables);
	}

	protected getVariablesInt(): Promise<VariableAdapter[]> {
		return Promise.resolve(this.variables);
	}

	protected getObjectGripAdaptersInt(): ObjectGripAdapter[] {
		return <ObjectGripAdapter[]>this.variables
			.map((variableAdapter) => variableAdapter.objectGripAdapter)
			.filter((objectGripAdapter) => (objectGripAdapter !== undefined));
	}
}

export class FunctionScopeAdapter extends ScopeAdapter {

	public name: string;
	public variables: VariableAdapter[] = [];

	public constructor(name: string, bindings: FirefoxDebugProtocol.FunctionBindings, referenceFrame: FrameAdapter) {
		super(name, referenceFrame);

		bindings.arguments.forEach((arg) => {
			for (let varname in arg) {
				this.variables.push(VariableAdapter.fromPropertyDescriptor(
					varname, this.referenceExpression, this.referenceFrame,
					arg[varname], false, this.threadAdapter));
			}
		});

		for (let varname in bindings.variables) {
			this.variables.push(VariableAdapter.fromPropertyDescriptor(
				varname, this.referenceExpression, this.referenceFrame,
				bindings.variables[varname], false, this.threadAdapter));
		}

		VariableAdapter.sortVariables(this.variables);
	}

	protected getVariablesInt(): Promise<VariableAdapter[]> {
		return Promise.resolve(this.variables);
	}

	protected getObjectGripAdaptersInt(): ObjectGripAdapter[] {
		return <ObjectGripAdapter[]>this.variables
			.map((variableAdapter) => variableAdapter.objectGripAdapter)
			.filter((objectGripAdapter) => (objectGripAdapter !== undefined));
	}
}
