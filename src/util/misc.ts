import * as os from 'os';
import * as FirefoxProfile from 'firefox-profile';

export function concatArrays<T>(arrays: T[][]): T[] {
	return [].concat.apply([], arrays);
}

export function delay(timeout: number): Promise<void> {
	return new Promise<void>((resolve) => {
		setTimeout(resolve, timeout);
	});
}

export function isWindowsPlatform(): boolean {
	return (os.platform() === 'win32');
}

export function exceptionGripToString(grip: FirefoxDebugProtocol.Grip | null | undefined) {

	if ((typeof grip === 'object') && (grip !== null) && (grip.type === 'object')) {

		let preview = (<FirefoxDebugProtocol.ObjectGrip>grip).preview;
		if (preview !== undefined) {

			if (preview.name === 'ReferenceError') {
				return 'not available';
			}

			let str = (preview.name !== undefined) ? (preview.name + ': ') : '';
			str += (preview.message !== undefined) ? preview.message : '';
			if (str !== '') {
				return str;
			}
		}

	} else if (typeof grip === 'string') {
		return grip;
	}

	return 'unknown error';
}


const identifierExpression = /^[a-zA-Z_$][a-zA-Z_$]*$/;

export function accessorExpression(objectExpression: string | undefined, propertyName: string): string | undefined {
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

export function findAddonId(addonPath: string): Promise<string> {
	return new Promise<string>((resolve, reject) => {
		var dummyProfile = new FirefoxProfile();
		(<any>dummyProfile)._addonDetails(addonPath, (addonDetails: { id?: string | null }) => {
			if (typeof addonDetails.id === 'string') {
				resolve(addonDetails.id);
			} else {
				reject('This debugger currently requires add-ons to specify an ID in their manifest');
			}
			dummyProfile.deleteDir(() => {});
		});
	});
}
