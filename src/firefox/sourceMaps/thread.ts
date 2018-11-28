import { EventEmitter } from 'events';
import * as url from 'url';
import isAbsoluteUrl = require('is-absolute-url');
import { SourceMapConsumer, RawSourceMap } from 'source-map';
import { Log } from '../../util/log';
import { getUri, urlDirname } from '../../util/net';
import { DebugConnection, ISourceActorProxy, SourceActorProxy, SourceMappingSourceActorProxy } from '../index';
import { IThreadActorProxy, ExceptionBreakpoints, UrlLocation } from '../actorProxy/thread';
import { SourceMappingInfo } from './info';

let log = Log.create('SourceMappingThreadActorProxy');

export class SourceMappingThreadActorProxy extends EventEmitter implements IThreadActorProxy {

	private sourceMappingInfos = new Map<string, Promise<SourceMappingInfo>>();

	public constructor(
		private readonly underlyingActorProxy: IThreadActorProxy,
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

			return this.sourceMappingInfos.get(source.actor)!;

		} else {

			let sourceMappingInfo = this.createSourceMappingInfo(source);
			this.sourceMappingInfos.set(source.actor, sourceMappingInfo);
			return sourceMappingInfo;
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
		}
		log.debug('Created SourceMapConsumer');

		let sourceMappingInfo = new SourceMappingInfo(
			sourceMappingSourceActors, sourceActor, sourceMapUrl, sourceMapConsumer, sourceRoot);

		for (let origSource of sourceMapConsumer.sources) {

			if (sourceRoot) {
				origSource = url.resolve(sourceRoot, origSource);
			}

			let sourceMappingSource = this.createOriginalSource(source, origSource, sourceMapUrl);

			let sourceMappingSourceActor = new SourceMappingSourceActorProxy(
				sourceMappingSource, sourceMappingInfo);

			sourceMappingSourceActors.push(sourceMappingSourceActor);
		}

		return sourceMappingInfo;
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

		let sourceMappingInfo = await this.getOrCreateSourceMappingInfo(frame.where.source);
		if (sourceMappingInfo.sourceMapUri && sourceMappingInfo.sourceMapConsumer) {

			let originalLocation = sourceMappingInfo.originalLocationFor({
				line: frame.where.line!, column: frame.where.column!
			});

			let originalSource = this.createOriginalSource(
				frame.where.source, originalLocation.source, sourceMappingInfo.sourceMapUri);

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

	public attach(): Promise<void> {
		return this.underlyingActorProxy.attach(false);
	}

	public resume(
		exceptionBreakpoints: ExceptionBreakpoints,
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
