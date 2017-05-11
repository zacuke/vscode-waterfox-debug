import { Log } from '../util/log';
import { ThreadAdapter, ObjectGripAdapter } from './index';
import { Variable } from 'vscode-debugadapter';

let log = Log.create('VariableAdapter');

export class VariableAdapter {

	public readonly objectGripAdapter?: ObjectGripAdapter;

	public constructor(
		public readonly varname: string,
		public readonly referenceExpression: string | undefined,
		public readonly displayValue: string,
		public readonly threadAdapter: ThreadAdapter,
		objectGrip?: FirefoxDebugProtocol.ObjectGrip,
		threadLifetime?: boolean
	) {
		if (objectGrip && (threadLifetime !== undefined)) {
			this.objectGripAdapter = new ObjectGripAdapter(this, objectGrip, threadLifetime);
		}
	}

	public getVariable(): Variable {
		return new Variable(this.varname, this.displayValue,
			this.objectGripAdapter ? this.objectGripAdapter.variablesProviderId : undefined);
	}

	public static fromGrip(
		varname: string,
		parentReferenceExpression: string | undefined,
		grip: FirefoxDebugProtocol.Grip,
		threadLifetime: boolean,
		threadAdapter: ThreadAdapter
	): VariableAdapter {

		let referenceExpression = accessorExpression(parentReferenceExpression, varname);

		if ((typeof grip === 'boolean') || (typeof grip === 'number')) {

			return new VariableAdapter(varname, referenceExpression, grip.toString(), threadAdapter);

		} else if (typeof grip === 'string') {

			return new VariableAdapter(varname, referenceExpression, `"${grip}"`, threadAdapter);

		} else {

			switch (grip.type) {

				case 'null':
				case 'undefined':
				case 'Infinity':
				case '-Infinity':
				case 'NaN':
				case '-0':

					return new VariableAdapter(varname, referenceExpression, grip.type, threadAdapter);

				case 'longString':

					return new VariableAdapter(
						varname, referenceExpression,
						(<FirefoxDebugProtocol.LongStringGrip>grip).initial, threadAdapter);

				case 'symbol':

					return new VariableAdapter(
						varname, referenceExpression,
						(<FirefoxDebugProtocol.SymbolGrip>grip).name, threadAdapter);

				case 'object':

					let objectGrip = <FirefoxDebugProtocol.ObjectGrip>grip;
					let vartype = objectGrip.class;
					return new VariableAdapter(
						varname, referenceExpression, vartype, threadAdapter,
						objectGrip, threadLifetime);

				default:

					log.warn(`Unexpected object grip of type ${grip.type}: ${JSON.stringify(grip)}`);
					return new VariableAdapter(varname, referenceExpression, grip.type, threadAdapter);

			}
		}
	}

	public static fromPropertyDescriptor(
		varname: string,
		parentReferenceExpression: string | undefined,
		propertyDescriptor: FirefoxDebugProtocol.PropertyDescriptor,
		threadLifetime: boolean,
		threadAdapter: ThreadAdapter
	): VariableAdapter {

		if ((<FirefoxDebugProtocol.DataPropertyDescriptor>propertyDescriptor).value !== undefined) {

			return VariableAdapter.fromGrip(
				varname, parentReferenceExpression,
				(<FirefoxDebugProtocol.DataPropertyDescriptor>propertyDescriptor).value,
				threadLifetime, threadAdapter);

		} else {

			let referenceExpression = accessorExpression(parentReferenceExpression, varname);
			return new VariableAdapter(varname, referenceExpression, 'undefined', threadAdapter);

		}
	}

	public static fromSafeGetterValueDescriptor(
		varname: string,
		parentReferenceExpression: string | undefined,
		safeGetterValueDescriptor: FirefoxDebugProtocol.SafeGetterValueDescriptor,
		threadLifetime: boolean,
		threadAdapter: ThreadAdapter
	): VariableAdapter {

		return VariableAdapter.fromGrip(
			varname, parentReferenceExpression, safeGetterValueDescriptor.getterValue,
			threadLifetime, threadAdapter);
	}

	public static sortVariables(variables: VariableAdapter[]): void {
		variables.sort((var1, var2) => VariableAdapter.compareStrings(var1.varname, var2.varname));
	}

	private static compareStrings(s1: string, s2: string): number {
		if (s1 < s2) {
			return -1;
		} else if (s1 === s2) {
			return 0;
		} else {
			return 1;
		}
	}
}

const identifierExpression = /^[a-zA-Z_$][a-zA-Z_$]*$/;

function accessorExpression(objectExpression: string | undefined, propertyName: string): string | undefined {
	if (objectExpression === undefined) {
		return undefined;
	} else if (objectExpression === '') {
		return propertyName;
	} else if (identifierExpression.test(propertyName)) {
		return `${objectExpression}.${propertyName}`;
	} else {
		const escapedPropertyName = propertyName.replace('\\', '\\\\').replace('\'', '\\\'');
		return `${objectExpression}['${escapedPropertyName}']`;
	}
}
