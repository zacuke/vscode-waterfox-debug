import * as path from 'path';
import { Log } from './log';
import { ParsedAddonConfiguration } from '../configuration';
import { isWindowsPlatform as detectWindowsPlatform } from './misc';

let log = Log.create('PathConversion');

let isWindowsPlatform = detectWindowsPlatform();

export let urlDetector = /^[a-zA-Z][a-zA-Z0-9\+\-\.]*\:\//;

export class PathMapper {

	constructor(
		private readonly pathMappings: { url: string | RegExp, path: string }[],
		private readonly addonConfig?: ParsedAddonConfiguration
	) {}

	public convertFirefoxSourceToPath(source: FirefoxDebugProtocol.Source): string | undefined {
		if (!source) return undefined;

		if (source.addonID && this.addonConfig && (source.addonID === this.addonConfig.id)) {

			let sourcePath = this.removeQueryString(path.join(this.addonConfig.path, source.addonPath!));
			log.debug(`Addon script path: ${sourcePath}`);
			return sourcePath;

		} else if (source.isSourceMapped && source.generatedUrl && source.url && !urlDetector.test(source.url)) {

			let generatedPath = this.convertFirefoxUrlToPath(source.generatedUrl);
			if (!generatedPath) return undefined;

			let relativePath = source.url;

			let sourcePath = this.removeQueryString(path.join(path.dirname(generatedPath), relativePath));
			log.debug(`Sourcemapped path: ${sourcePath}`);
			return sourcePath;

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

					let path = this.removeQueryString(to + url.substr(from.length));
					if (isWindowsPlatform) {
						path = path.replace(/\//g, '\\');
					}

					log.debug(`Converted url ${url} to path ${path}`);
					return path;
				}

			} else {

				let match = from.exec(url);
				if (match) {

					let path = this.removeQueryString(to + match[1]);
					if (isWindowsPlatform) {
						path = path.replace(/\//g, '\\');
					}

					log.debug(`Converted url ${url} to path ${path}`);
					return path;
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