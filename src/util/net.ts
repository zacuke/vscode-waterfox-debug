import * as url from 'url';
import * as fs from 'fs';
import * as net from 'net';
import * as http from 'http';
import * as https from 'https';
import fileUriToPath = require('file-uri-to-path');
import dataUriToBuffer = require('data-uri-to-buffer');
import { Log } from "./log";
import { delay } from './misc';

let log = Log.create('net');

export function connect(port: number, host?: string): Promise<net.Socket> {
	return new Promise<net.Socket>((resolve, reject) => {
		let socket = net.connect(port, host || 'localhost');
		socket.on('connect', () => resolve(socket));
		socket.on('error', reject);
	});
}

export async function waitForSocket(port: number): Promise<net.Socket> {
	let lastError: any;
	for (var i = 0; i < 25; i++) {
		try {
			return await connect(port);
		} catch(err) {
			lastError = err;
			await delay(200);
		}
	}
	throw lastError;
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
