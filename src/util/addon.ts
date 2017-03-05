import * as path from 'path';
import * as fs from 'fs';
import { execSync } from 'child_process';
import * as semver from 'semver';
import { AddonType } from '../adapter/launchConfiguration';
import * as FirefoxProfile from 'firefox-profile';
import * as zipdir from 'zip-dir';

export function createXpi(addonType: AddonType, addonPath: string, destDir: string): Promise<string> {
	return new Promise<string>((resolve, reject) => {

		switch (addonType) {

			case 'legacy':
			case 'webExtension':
				let destFile = path.join(destDir, 'addon.xpi');
				zipdir(addonPath, { saveTo: destFile },
				(err, buffer) => {
					if (err) {
						reject(err);
					} else {
						resolve(destFile);
					}
				});
				break;

			case 'addonSdk':
				try {
					let jpmVersion = execSync('jpm -V', { encoding: 'utf8' });
					jpmVersion = (<string>jpmVersion).trim();
					if (semver.lt(jpmVersion, '1.2.0')) {
						reject(`Please install a newer version of jpm (You have ${jpmVersion}, but 1.2.0 or newer is required)`);
						return;
					}

					execSync(`jpm xpi --dest-dir "${destDir}"`, { cwd: addonPath });
					resolve(path.join(destDir, fs.readdirSync(destDir)[0]));

				} catch (err) {
					reject(`Couldn't run jpm: ${err.stderr}`);
				}
				break;
		}
	});
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
		});
	});
}
