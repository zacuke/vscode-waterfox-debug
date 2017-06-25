import fileUriToPath = require('file-uri-to-path');
import dataUriToBuffer = require('data-uri-to-buffer');
import * as os from 'os';
import * as url from 'url';
import * as fs from 'fs';
import * as http from 'http';
import * as https from 'https';
import { Log } from "./log";

let log = Log.create('misc');

export function concatArrays<T>(arrays: T[][]): T[] {
	return [].concat.apply([], arrays);
}

export function urlBasename(url: string): string {
	let lastSepIndex = url.lastIndexOf('/');
	if (lastSepIndex < 0) {
		return url;
	} else {
		return url.substring(lastSepIndex + 1);
	}
}

export function urlDirname(url: string): string {
	let lastSepIndex = url.lastIndexOf('/');
	if (lastSepIndex < 0) {
		return url;
	} else {
		return url.substring(0, lastSepIndex + 1);
	}
}

export function delay(timeout: number): Promise<void> {
	return new Promise<void>((resolve) => {
		setTimeout(resolve, timeout);
	});
}

export function isExecutable(path: string): boolean {
	try {
		fs.accessSync(path, fs.constants.X_OK);
		return true;
	} catch (e) {
		return false;
	}
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

export function getUri(uri: string): Promise<string> {

	if (uri.startsWith('data:')) {
		return Promise.resolve(dataUriToBuffer(uri).toString());
	}

	if (uri.startsWith('file:')) {
		return new Promise((resolve, reject) => {
			fs.readFile(fileUriToPath(uri), 'utf8', (err, data) => {
				if (err) {
					reject(err);
				} else {
					resolve(data);
				}
			});
		});
	}

	return new Promise((resolve, reject) => {
		const parsedUrl = url.parse(uri);
		const get = (parsedUrl.protocol === 'https:') ? https.get : http.get;
		const options = Object.assign({ rejectUnauthorized: false }, parsedUrl) as https.RequestOptions;

		get(options, response => {
			let responseData = '';
			response.on('data', chunk => responseData += chunk);
			response.on('end', () => {
				if (response.statusCode === 200) {
					resolve(responseData);
				} else {
					log.error(`HTTP GET failed with: ${response.statusCode} ${response.statusMessage}`);
					reject(new Error(responseData.trim()));
				}
			});
		}).on('error', e => {
			log.error(`HTTP GET failed: ${e}`);
			reject(e);
		});
	});

}
