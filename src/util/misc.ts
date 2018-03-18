import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs-extra';
import FirefoxProfile = require('firefox-profile');
import { AddonType } from '../configuration';

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

export function pathsAreEqual(path1: string, path2: string | undefined) {
	if (path2 === undefined) return false;
	if (isWindowsPlatform()) {
		return path1.toUpperCase() === path2.toUpperCase();
	} else {
		return path1 === path2;
	}
}

export function exceptionGripToString(grip: FirefoxDebugProtocol.Grip | null | undefined) {

	if ((typeof grip === 'object') && (grip !== null) && (grip.type === 'object')) {

		let preview = (<FirefoxDebugProtocol.ObjectGrip>grip).preview;
		if (preview && (preview.kind === 'Error')) {

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

export function findAddonId(addonPath: string, addonType: AddonType): Promise<string> {
	if (addonType === 'webExtension') {
		return findWebExtensionId(addonPath);
	} else {
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
}

async function findWebExtensionId(addonPath: string): Promise<string> {
	const manifest = await fs.readJson(path.join(addonPath, 'manifest.json'));
	const id = ((manifest.applications || {}).gecko || {}).id;
	if (typeof id === 'string') {
		return id;
	} else {
		throw 'This debugger currently requires add-ons to specify an ID in their manifest';
	}
}
