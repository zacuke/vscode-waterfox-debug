import { EventEmitter } from 'events';
import * as url from 'url';
import isAbsoluteUrl = require('is-absolute-url');
import pathToFileUri = require('file-url');
import { SourceMapConsumer, RawSourceMap } from 'source-map';
import { Log } from '../../util/log';
import { PathMapper } from '../../util/pathMapper';
import { getUri, urlDirname, canGetUri } from '../../util/net';
import { PendingRequest } from '../../util/pendingRequests';
import { DebugConnection, ISourceActorProxy, SourceActorProxy, SourceMappingSourceActorProxy } from '../index';
import { IThreadActorProxy, ExceptionBreakpoints, UrlLocation, AttachOptions } from '../actorProxy/thread';
import { SourceMappingInfo } from './info';

let log = Log.create('SourceMappingThreadActorProxy');

export class SourceMappingThreadActorProxy extends EventEmitter implements IThreadActorProxy {

	private sourceMappingInfos = new Map<string, Promise<SourceMappingInfo>>();
	private pendingSources = new Map<string, PendingRequest<SourceMappingInfo>>();

	public constructor(
		private readonly underlyingActorProxy: IThreadActorProxy,
		private readonly pathMapper: PathMapper,
		private readonly connection: DebugConnection
	) {
		super();

		underlyingActorProxy.onNewSource(async (actor) => {
			let sourceMappingInfo = await this.getOrCreateSourceMappingInfo(actor.source);
			for (let source of sourceMappingInfo.sources) {
				this.emit('newSource', source);
			}
		});
	}

	public get name(): string {
		return this.underlyingActorProxy.name;
	}

	public async fetchSources(): Promise<FirefoxDebugProtocol.Source[]> {

		let underlyingSources = await this.underlyingActorProxy.fetchSources();

		let allMappedSources: FirefoxDebugProtocol.Source[] = [];
		for (let source of underlyingSources) {
			let info = await this.getOrCreateSourceMappingInfo(source);
			let mappedSources = info.sources.map((actor) => actor.source);
			allMappedSources.push(...mappedSources);
		}

		return allMappedSources;
	}

	private getOrCreateSourceMappingInfo(
		source: FirefoxDebugProtocol.Source
	): Promise<SourceMappingInfo> {

		if (this.sourceMappingInfos.has(source.actor)) {

			if (this.pendingSources.has(source.actor)) {

				const pending = this.pendingSources.get(source.actor)!;
				this.pendingSources.delete(source.actor);

				(async () => {
					try {

						const sourceMappingInfos = await this.createSourceMappingInfo(source);
						pending.resolve(sourceMappingInfos);

					} catch(e) {
						pending.reject(e);
					}
				})();
			}

			return this.sourceMappingInfos.get(source.actor)!;

		} else {

			let sourceMappingInfoPromise = this.createSourceMappingInfo(source);
			this.sourceMappingInfos.set(source.actor, sourceMappingInfoPromise);
			return sourceMappingInfoPromise;
		}
	}

	private async createSourceMappingInfo(
		source: FirefoxDebugProtocol.Source
	): Promise<SourceMappingInfo> {

		if (log.isDebugEnabled) {
			log.debug(`Trying to sourcemap ${JSON.stringify(source)}`);
		}

		let sourceActor = this.connection.getOrCreate(
			source.actor, () => new SourceActorProxy(source, this.connection));

		let sourceMapUrl = source.sourceMapURL;
		if (!sourceMapUrl) {
			return new SourceMappingInfo([sourceActor], sourceActor);
		}

		if (!isAbsoluteUrl(sourceMapUrl)) {
			if (source.url) {
				sourceMapUrl = url.resolve(urlDirname(source.url), sourceMapUrl);
			} else {
				log.warn(`Can't create absolute sourcemap URL from ${sourceMapUrl} - giving up`);
				return new SourceMappingInfo([sourceActor], sourceActor);
			}
		}

		if (!canGetUri(sourceMapUrl)) {
			const sourceMapPath = this.pathMapper.convertFirefoxUrlToPath(sourceMapUrl);
			if (sourceMapPath) {
				sourceMapUrl = pathToFileUri(sourceMapPath, { resolve: false });
			} else {
				log.warn(`Failed fetching sourcemap from ${sourceMapUrl} - giving up`);
				return new SourceMappingInfo([sourceActor], sourceActor);
			}
		}

		let rawSourceMap: RawSourceMap;
		try {
			const sourceMapString = await getUri(sourceMapUrl);
			log.debug('Received sourcemap');
			rawSourceMap = JSON.parse(sourceMapString);
			log.debug('Parsed sourcemap');
		} catch(e) {
			log.warn(`Failed fetching sourcemap from ${sourceMapUrl} - giving up`);
			return new SourceMappingInfo([sourceActor], sourceActor);
		}

		let sourceMapConsumer = await new SourceMapConsumer(rawSourceMap);
		let sourceMappingSourceActors: SourceMappingSourceActorProxy[] = [];
		let sourceRoot = rawSourceMap.sourceRoot;
		if (!sourceRoot && source.url) {
			sourceRoot = urlDirname(source.url);
		} else if ((sourceRoot !== undefined) && !isAbsoluteUrl(sourceRoot)) {
			sourceRoot = url.resolve(sourceMapUrl, sourceRoot);
		}
		log.debug('Created SourceMapConsumer');

		let sourceMappingInfo = new SourceMappingInfo(
			sourceMappingSourceActors, sourceActor, sourceMapUrl, sourceMapConsumer, sourceRoot);

		for (let origSource of sourceMapConsumer.sources) {

			origSource = sourceMappingInfo.resolveSource(origSource);

			let sourceMappingSource = this.createOriginalSource(source, origSource, sourceMapUrl);

			let sourceMappingSourceActor = new SourceMappingSourceActorProxy(
				sourceMappingSource, sourceMappingInfo);

			sourceMappingSourceActors.push(sourceMappingSourceActor);
		}

		return sourceMappingInfo;
	}

	private getSourceMappingInfo(actor: string): Promise<SourceMappingInfo> {

		if (this.sourceMappingInfos.has(actor)) {

			return this.sourceMappingInfos.get(actor)!;

		} else {

			const promise = new Promise<SourceMappingInfo>((resolve, reject) => {
				this.pendingSources.set(actor, { resolve, reject });
			});

			this.sourceMappingInfos.set(actor, promise);

			return promise;
		}
	}

	public async fetchStackFrames(
		start?: number,
		count?: number
	): Promise<FirefoxDebugProtocol.Frame[]> {

		let stackFrames = await this.underlyingActorProxy.fetchStackFrames(start, count);

		await Promise.all(stackFrames.map((frame) => this.applySourceMapToFrame(frame)));

		return stackFrames;
	}

	private async applySourceMapToFrame(frame: FirefoxDebugProtocol.Frame): Promise<void> {

		let sourceMappingInfo: SourceMappingInfo | undefined;
		let source = frame.where.source;
		if (source) {
			sourceMappingInfo = await this.getOrCreateSourceMappingInfo(source);
		} else {
			const sourceMappingInfoPromise = this.getSourceMappingInfo(frame.where.actor!);
			sourceMappingInfo = await sourceMappingInfoPromise;
			source = sourceMappingInfo.underlyingSource.source;
		}

		if (sourceMappingInfo && sourceMappingInfo.sourceMapUri && sourceMappingInfo.sourceMapConsumer) {

			let originalLocation = sourceMappingInfo.originalLocationFor({
				line: frame.where.line!, column: frame.where.column!
			});

			let originalSource = this.createOriginalSource(
				source!, originalLocation.source, sourceMappingInfo.sourceMapUri);

			frame.where = {
				source: originalSource,
				line: originalLocation.line || undefined,
				column: originalLocation.column || undefined
			}
		}
	}

	private createOriginalSource(
		generatedSource: FirefoxDebugProtocol.Source,
		originalSourceUrl: string | null,
		sourceMapUrl: string
	): FirefoxDebugProtocol.Source {

		return <FirefoxDebugProtocol.Source>{
			actor: `${generatedSource.actor}!${originalSourceUrl}`,
			url: originalSourceUrl,
			introductionUrl: generatedSource.introductionUrl,
			introductionType: generatedSource.introductionType,
			generatedUrl: generatedSource.url,
			isBlackBoxed: false,
			isPrettyPrinted: false,
			isSourceMapped: true,
			sourceMapURL: sourceMapUrl
		}
	}

	public async setBreakpoint(line: number, column: number, sourceUrl: string, condition?: string, logValue?: string): Promise<void> {

		if (log.isDebugEnabled) log.debug(`Computing generated location for ${line}:${column} in ${sourceUrl}`);
		let generatedLocation = await this.findGeneratedLocation(sourceUrl, line, column);
		if (generatedLocation) {
			if (log.isDebugEnabled) log.debug(`Got generated location ${generatedLocation.line}:${generatedLocation.column}`);
		} else {
			if (log.isWarnEnabled) log.warn(`Couldn't find generated location for ${line}:${column} in ${sourceUrl}`);
			return;
		}

		await this.underlyingActorProxy.setBreakpoint(generatedLocation.line, generatedLocation.column!, generatedLocation.url, condition, logValue);
	}

	public async removeBreakpoint(line: number, column: number, sourceUrl: string): Promise<void> {

		if (log.isDebugEnabled) log.debug(`Computing generated location for ${line}:${column} in ${sourceUrl}`);
		let generatedLocation = await this.findGeneratedLocation(sourceUrl, line, column);
		if (generatedLocation) {
			if (log.isDebugEnabled) log.debug(`Got generated location ${generatedLocation.line}:${generatedLocation.column}`);
		} else {
			if (log.isWarnEnabled) log.warn(`Couldn't find generated location for ${line}:${column} in ${sourceUrl}`);
			return;
		}

		await this.underlyingActorProxy.removeBreakpoint(generatedLocation.line, generatedLocation.column!, generatedLocation.url);
	}

	public pauseOnExceptions(pauseOnExceptions: boolean, ignoreCaughtExceptions: boolean): Promise<void> {
		return this.underlyingActorProxy.pauseOnExceptions(pauseOnExceptions, ignoreCaughtExceptions);
	}

	public attach(options: AttachOptions): Promise<void> {
		return this.underlyingActorProxy.attach(options);
	}

	public resume(
		exceptionBreakpoints: ExceptionBreakpoints | undefined,
		resumeLimitType?: "next" | "step" | "finish" | undefined
	): Promise<void> {
		return this.underlyingActorProxy.resume(exceptionBreakpoints, resumeLimitType);
	}

	public interrupt(immediately: boolean = true): Promise<void> {
		return this.underlyingActorProxy.interrupt(immediately);
	}

	public detach(): Promise<void> {
		return this.underlyingActorProxy.detach();
	}

	public async findOriginalLocation(
		generatedUrl: string,
		line: number,
		column?: number
	): Promise<UrlLocation | undefined> {

		for (const infoPromise of this.sourceMappingInfos.values()) {
			const info = await infoPromise;
			if (generatedUrl === info.underlyingSource.url) {

				const originalLocation = info.originalLocationFor({ line, column: column || 1 });

				if (originalLocation.source && originalLocation.line) {
					return {
						url: originalLocation.source, 
						line: originalLocation.line,
						column: originalLocation.column || undefined
					};
				}
			}
		}

		return undefined;
	}

	private async findGeneratedLocation(
		sourceUrl: string,
		line: number,
		column: number
	): Promise<UrlLocation | undefined> {

		for (const infoPromise of this.sourceMappingInfos.values()) {
			const info = await infoPromise;
			for (const originalSource of info.sources) {
				if (sourceUrl === originalSource.url) {

					const generatedLocation = info.generatedLocationFor({ source: sourceUrl, line, column });
	
					if ((generatedLocation.line !== null) && (generatedLocation.column !== null)) {
						return {
							url: info.underlyingSource.url!,
							line: generatedLocation.line,
							column: generatedLocation.column
						};
					}
				}
			}
		}

		return undefined;
	}

	public onPaused(cb: (_event: FirefoxDebugProtocol.ThreadPausedResponse) => void): void {
		this.underlyingActorProxy.onPaused(async (event) => {
			await this.applySourceMapToFrame(event.frame);
			cb(event);
		});
	}

	public onResumed(cb: () => void): void {
		this.underlyingActorProxy.onResumed(cb);
	}

	public onExited(cb: () => void): void {
		this.underlyingActorProxy.onExited(cb);
	}

	public onWrongState(cb: () => void): void {
		this.underlyingActorProxy.onWrongState(cb);
	}

	public onNewSource(cb: (newSource: ISourceActorProxy) => void): void {
		this.on('newSource', cb);
	}

	public onNewGlobal(cb: () => void): void {
		this.underlyingActorProxy.onNewGlobal(cb);
	}

	public dispose(): void {
		this.underlyingActorProxy.dispose();
	}
}
