import * as path from 'path';
import * as url from 'url';
import { Log } from './log';
import { PathMappings, ParsedAddonConfiguration } from '../configuration';
import { isWindowsPlatform as detectWindowsPlatform } from '../../common/util';
import { urlDirname } from './net';

let log = Log.create('PathConversion');

let isWindowsPlatform = detectWindowsPlatform();

export let urlDetector = /^[a-zA-Z][a-zA-Z0-9\+\-\.]*\:\/\//;

export class PathMapper {

	constructor(
		private readonly pathMappings: PathMappings,
		private readonly addonConfig?: ParsedAddonConfiguration
	) {}

	public convertFirefoxSourceToPath(source: FirefoxDebugProtocol.Source): string | undefined {
		if (!source) return undefined;

		if (source.addonID && this.addonConfig && (source.addonID === this.addonConfig.id)) {

			let sourcePath = this.removeQueryString(path.join(this.addonConfig.path, source.addonPath!));
			log.debug(`Addon script path: ${sourcePath}`);
			return sourcePath;

		} else if (source.isSourceMapped && source.generatedUrl && source.url && !urlDetector.test(source.url)) {

			let originalPathOrUrl = source.url;

			if (path.isAbsolute(originalPathOrUrl)) {

				log.debug(`Sourcemapped absolute path: ${originalPathOrUrl}`);

				if (isWindowsPlatform) {
					originalPathOrUrl = path.normalize(originalPathOrUrl);
				}

				return originalPathOrUrl;

			} else {

				let generatedUrl = source.generatedUrl;
				if ((source.introductionType === 'wasm') && generatedUrl.startsWith('wasm:')) {
					generatedUrl = generatedUrl.substr(5);
				}

				let sourcePath: string | undefined;
				if (originalPathOrUrl.startsWith('../')) {

					let generatedPath = this.convertFirefoxUrlToPath(generatedUrl);
					if (!generatedPath) return undefined;
					sourcePath = path.join(path.dirname(generatedPath), originalPathOrUrl);

				} else {

					let sourceUrl = url.resolve(urlDirname(generatedUrl), originalPathOrUrl);
					sourcePath = this.convertFirefoxUrlToPath(sourceUrl);
					if (!sourcePath) return undefined;

				}

				sourcePath = this.removeQueryString(sourcePath);

				log.debug(`Sourcemapped path: ${sourcePath}`);

				return sourcePath;
			}

		} else if (source.url) {
			return this.convertFirefoxUrlToPath(source.url);
		} else {
			return undefined;
		}
	}

	public convertFirefoxUrlToPath(url: string): string | undefined {

		for (var i = 0; i < this.pathMappings.length; i++) {

			let { url: from, path: to } = this.pathMappings[i];

			if (typeof from === 'string') {

				if (url.substr(0, from.length) === from) {

					if (to === null) {
						log.debug(`Url ${url} not converted to path`);
						return undefined;
					}

					let thePath = this.removeQueryString(to + decodeURIComponent(url.substr(from.length)));
					if (isWindowsPlatform) {
						thePath = path.normalize(thePath);
					}

					log.debug(`Converted url ${url} to path ${thePath}`);
					return thePath;
				}

			} else {

				let match = from.exec(url);
				if (match) {

					if (to === null) {
						log.debug(`Url ${url} not converted to path`);
						return undefined;
					}

					let thePath = this.removeQueryString(to + decodeURIComponent(match[1]));
					if (isWindowsPlatform) {
						thePath = path.normalize(thePath);
					}

					log.debug(`Converted url ${url} to path ${thePath}`);
					return thePath;
				}
			}
		}

		log.info(`Can't convert url ${url} to path`);

		return undefined;
	}

	private removeQueryString(path: string): string {
		let queryStringIndex = path.indexOf('?');
		if (queryStringIndex >= 0) {
			return path.substr(0, queryStringIndex);
		} else {
			return path;
		}
	}
}