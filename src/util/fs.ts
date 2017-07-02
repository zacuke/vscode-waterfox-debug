import * as fs from 'fs-extra';
import { delay } from './misc';
import { Log } from './log';

let log = Log.create('fs');

export function isExecutable(path: string): boolean {
	try {
		fs.accessSync(path, fs.constants.X_OK);
		return true;
	} catch (e) {
		return false;
	}
}

export async function tryRemoveRepeatedly(dir: string): Promise<void> {
	for (var i = 0; i < 5; i++) {
		try {
			await tryRemove(dir);
			log.debug(`Removed ${dir}`);
			return;
		} catch (err) {
			if (i < 4) {
				log.debug(`Attempt to remove ${dir} failed, will retry in 100ms`);
				await delay(100);
			} else {
				log.debug(`Attempt to remove ${dir} failed, giving up`);
				throw err;
			}
		}
	}
}

export function tryRemove(dir: string): Promise<void> {
	return new Promise<void>((resolve, reject) => {
		fs.remove(dir, (err) => {
			if (!err) {
				resolve();
			} else {
				reject(err);
			}
		})
	})
}
