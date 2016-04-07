import * as os from 'os';
import * as path from 'path';
import { accessSync, X_OK } from 'fs';
import { connect, Socket } from 'net';
import { spawn, ChildProcess } from 'child_process';
import { LaunchConfiguration } from '../adapter/launchConfiguration';

export function launchFirefox(config: LaunchConfiguration, 
	convertPathToFirefoxUrl: (path: string) => string): ChildProcess | string {

	let firefoxPath = getFirefoxExecutablePath(config);	
	if (!firefoxPath) {
		let errorMsg = 'Couldn\'t find the Firefox executable. ';
		if (config.firefoxExecutable) {
			errorMsg += 'Please correct the path given in your launch configuration.'
		} else {
			errorMsg += 'Please specify the path in your launch configuration.'
		}
		return errorMsg;
	}
	
	let port = config.port || 6000;
	let firefoxArgs: string[] = [ '-start-debugger-server', String(port), '-no-remote' ];
	if (config.profile) {
		firefoxArgs.push('-P', config.profile);
	}
	if (Array.isArray(config.firefoxArgs)) {
		firefoxArgs = firefoxArgs.concat(config.firefoxArgs);
	}
	if (config.file) {
		if (!path.isAbsolute(config.file)) {
			return 'The "file" property in the launch configuration has to be an absolute path';
		}
		firefoxArgs.push(convertPathToFirefoxUrl(config.file));
	} else if (config.url) {
		firefoxArgs.push(config.url);
	} else {
		return 'You need to set either "file" or "url" in the launch configuration';
	}
	
	let childProc = spawn(firefoxPath, firefoxArgs, { detached: true, stdio: 'ignore' });
	childProc.unref();
	return childProc;
}

export function waitForSocket(config: LaunchConfiguration): Promise<Socket> {
	let port = config.port || 6000;
	return new Promise<Socket>((resolve, reject) => {
		tryConnect(port, 200, 25, resolve, reject);
	});
}

function getFirefoxExecutablePath(config: LaunchConfiguration): string {

	if (config.firefoxExecutable) {
		if (isExecutable(config.firefoxExecutable)) {
			return config.firefoxExecutable;
		} else {
			return null;
		}
	}
	
	let candidates: string[] = [];
	switch (os.platform()) {
		
		case 'linux':
		case 'freebsd':
		case 'sunos':
			candidates = [
				'/usr/bin/firefox'
			]
			break;

		case 'darwin':
			candidates = [
				'/Applications/Firefox.app/Contents/MacOS/firefox'
			]
			break;

		case 'win32':
			candidates = [
				'C:\\Program Files (x86)\\Mozilla Firefox\\firefox.exe',
				'C:\\Program Files\\Mozilla Firefox\\firefox.exe'
			]
			break;
	}

	for (let i = 0; i < candidates.length; i++) {
		if (isExecutable(candidates[i])) {
			return candidates[i];
		}
	}
	
	return null;
}

function isExecutable(path: string): boolean {
	try {
		accessSync(path, X_OK);
		return true;
	} catch (e) {
		return false;
	}
}

function tryConnect(port: number, retryAfter: number, tries: number, 
	resolve: (sock: Socket) => void, reject: (err: any) => void) {
	
	let socket = connect(port);
	socket.on('connect', () => resolve(socket));
	socket.on('error', (err) => {
		if (tries > 0) {
			setTimeout(() => tryConnect(port, retryAfter, tries - 1, resolve, reject), retryAfter);
		} else {
			reject(err);
		}
	});
}
