import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { execSync } from 'child_process';
import * as uuid from 'node-uuid';
import * as semver from 'semver';
import { AddonType } from '../adapter/launchConfiguration';
import * as FirefoxProfile from 'firefox-profile';
import * as getJetpackAddonId from 'jetpack-id';
import * as zipdir from 'zip-dir';

/**
 * Returns either true and the addonId or false and an error message
 */
export function findAddonId(addonType: AddonType, addonPath: string): [boolean, string] {
	let manifestPath: string;
	let manifest: any;
	switch (addonType) {

		case 'legacy':
			manifestPath = path.join(addonPath, 'install.rdf');
			try {
				fs.accessSync(manifestPath, fs.constants.R_OK);
			} catch (err) {
				return [false, `Couldn't read ${manifestPath}`];
			}
			return [true, getLegacyAddonId(addonPath)];

		case 'addonSdk':
			manifestPath = path.join(addonPath, 'package.json');
			try {
				fs.accessSync(manifestPath, fs.constants.R_OK);
			} catch (err) {
				return [false, `Couldn't read ${manifestPath}`];
			}
			manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
			return [true, getJetpackAddonId(manifest)];

		case 'webExtension':
			manifestPath = path.join(addonPath, 'manifest.json');
			try {
				fs.accessSync(manifestPath, fs.constants.R_OK);
			} catch (err) {
				return [false, `Couldn't read ${manifestPath}`];
			}
			manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
			let addonId = (((manifest || {}).applications || {}).gecko || {}).id;
			if (!addonId) {
				return [false, `Please define your addonId (as applications.gecko.id) in ${manifestPath}`];
			}
			return [true, addonId];
	}
}

export function installAddon(addonType: AddonType, addonId: string, addonDir: string, profileDir: string): Promise<void> {

	let destDir = path.join(profileDir, 'extensions');
	let destFile = path.join(destDir, `${addonId}.xpi`);
	try {
		fs.mkdirSync(destDir);
	} catch(e) {}

	switch (addonType) {

		case 'legacy':
		case 'webExtension':
			return new Promise<void>((resolve, reject) => {
				zipdir(addonDir, { saveTo: destFile }, (err, buffer) => {
					if (err) {
						reject(err);
					} else {
						resolve(undefined);
					}
				});
			});

		case 'addonSdk':
			return createJetpackXpi(addonDir, destFile);
	}
}

export function createJetpackXpi(addonDir: string, destFile: string): Promise<void> {
	return new Promise<void>((resolve, reject) => {
		try {

			let tempXpiDir = path.join(os.tmpdir(), `jpm-${uuid.v4()}`);
			fs.mkdirSync(tempXpiDir);

			let jpmVersion = execSync('jpm -V', { encoding: 'utf8' });
			jpmVersion = (<string>jpmVersion).trim();
			if (semver.lt(jpmVersion as string, '1.2.0')) {
				reject(`Please install a newer version of jpm (You have ${jpmVersion}, but 1.2.0 or newer is required)`);
			}

			execSync(`jpm xpi --dest-dir "${tempXpiDir}"`, { cwd: addonDir });
			var tempXpiFile = path.join(tempXpiDir, fs.readdirSync(tempXpiDir)[0]);
			fs.renameSync(tempXpiFile, destFile);
			fs.rmdirSync(tempXpiDir);
			resolve();

		} catch (err) {
			reject(`Couldn't run jpm: ${err.stderr}`);
		}
	});
}

// we perform some Voodoo tricks to extract the private _addonDetails method
// (which uses the _sanitizePref method) from FirefoxProfile
class FirefoxProfileVoodoo {
	_addonDetails: Function;
	_sanitizePref: Function;
}
FirefoxProfileVoodoo.prototype._addonDetails = FirefoxProfile.prototype._addonDetails;
FirefoxProfileVoodoo.prototype._sanitizePref = FirefoxProfile.prototype._sanitizePref;
// and now more Voodoo tricks to turn the (blocking) callback-based method
// into a simple synchronous method
function getLegacyAddonId(addonPath: string): string {
	let addonDetails: any;
	let voodoo = new FirefoxProfileVoodoo();
	voodoo._addonDetails(addonPath, (result: any) => addonDetails = result);
	return addonDetails.id;
}
