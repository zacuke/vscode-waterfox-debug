import { EventEmitter } from 'events';
import * as url from 'url';
import isAbsoluteUrl = require('is-absolute-url');
import { SourceMapConsumer, RawSourceMap } from 'source-map';
import { Log } from '../../util/log';
import { getUri, urlDirname } from '../../util/net';
import { DebugConnection, ISourceActorProxy, SourceActorProxy, SourceMappingSourceActorProxy } from '../index';
import { IThreadActorProxy, ExceptionBreakpoints } from '../actorProxy/thread';
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

		let sourceMapUri = source.sourceMapURL;
		if (!sourceMapUri) {
			return new SourceMappingInfo([sourceActor], sourceActor);
		}

		if (!isAbsoluteUrl(sourceMapUri)) {
			if (source.url) {
				sourceMapUri = url.resolve(urlDirname(source.url), sourceMapUri);
			} else {
				log.warn(`Can't create absolute sourcemap URL from ${sourceMapUri} - giving up`);
				return new SourceMappingInfo([sourceActor], sourceActor);
			}
		}

		let rawSourceMap: RawSourceMap;
		try {
			rawSourceMap = JSON.parse(await getUri(sourceMapUri));
		} catch(e) {
			log.warn(`Failed fetching sourcemap from ${sourceMapUri} - giving up`);
			return new SourceMappingInfo([sourceActor], sourceActor);
		}

		let sourceMapConsumer = new SourceMapConsumer(rawSourceMap);
		let sourceMappingSourceActors: SourceMappingSourceActorProxy[] = [];
		let sourceRoot = rawSourceMap.sourceRoot;
		if (!sourceRoot && source.url) {
			sourceRoot = urlDirname(source.url);
		}

		let sourceMappingInfo = new SourceMappingInfo(
			sourceMappingSourceActors, sourceActor, sourceMapUri, sourceMapConsumer, sourceRoot);

		for (let origSource of (<any>sourceMapConsumer).sources) {

			if (sourceRoot) {
				origSource = url.resolve(sourceRoot, origSource);
			}

			let sourceMappingSource = this.createOriginalSource(source, origSource, sourceMapUri);

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
				line: originalLocation.line,
				column: originalLocation.column
			}
		}
	}

	private createOriginalSource(
		generatedSource: FirefoxDebugProtocol.Source,
		originalSourceUrl: string,
		sourceMapUri: string
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
			sourceMapURL: sourceMapUri
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
