import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs-extra';
import FirefoxProfile from 'firefox-profile';
import stripJsonComments from 'strip-json-comments';
import { AddonType } from '../configuration';

export function concatArrays<T>(arrays: T[][]): T[] {
	return ([] as T[]).concat.apply([], arrays);
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

export function normalizePath(rawPath: string) {
	let normalized = path.normalize(rawPath);
	if (isWindowsPlatform()) {
		normalized = normalized.replace(/\\/g, '/');
	}
	if (normalized[normalized.length - 1] === '/') {
		normalized = normalized.substr(0, normalized.length - 1);
	}

	return normalized;
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

export function findAddonId(addonPath: string, addonType: AddonType): Promise<string | undefined> {
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

async function findWebExtensionId(addonPath: string): Promise<string | undefined> {
	try {
		const rawManifest = await fs.readFile(path.join(addonPath, 'manifest.json'), { encoding: 'utf8' });
		const manifest = JSON.parse(stripJsonComments(rawManifest));
		const id = ((manifest.applications || {}).gecko || {}).id;
		return id;
	} catch (err) {
		throw `Couldn't parse manifest.json: ${err}`;
	}
}
