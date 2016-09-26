import * as path from 'path';
import * as fs from 'fs';
import { AddonType } from '../adapter/launchConfiguration';
import * as FirefoxProfile from 'firefox-profile';
import * as getJetpackAddonId from 'jetpack-id';

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
				fs.accessSync(manifestPath, fs.R_OK);
			} catch (err) {
				return [false, `Couldn't read ${manifestPath}`];
			}
			return [true, getLegacyAddonId(addonPath)];

		case 'addonSdk':
			manifestPath = path.join(addonPath, 'package.json');
			try {
				fs.accessSync(manifestPath, fs.R_OK);
			} catch (err) {
				return [false, `Couldn't read ${manifestPath}`];
			}
			manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
			return [true, getJetpackAddonId(manifest)];

		case 'webExtension':
			manifestPath = path.join(addonPath, 'manifest.json');
			try {
				fs.accessSync(manifestPath, fs.R_OK);
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

// we perform some Voodoo tricks to extract the private _addonDetails method
// (which uses the _sanitizePref method) from FirefoxProfile
function FirefoxProfileVoodoo() {}
FirefoxProfileVoodoo.prototype._addonDetails = FirefoxProfile.prototype._addonDetails;
FirefoxProfileVoodoo.prototype._sanitizePref = FirefoxProfile.prototype._sanitizePref;
// and now more Voodoo tricks to turn the (blocking) callback-based method
// into a simple synchronous method
function getLegacyAddonId(addonPath: string): string {
	let addonDetails: any;
	let voodoo = new FirefoxProfileVoodoo();
	voodoo._addonDetails(addonPath, result => addonDetails = result);
	return addonDetails.id;
}
