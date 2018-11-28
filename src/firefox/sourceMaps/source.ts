import { Log } from '../../util/log';
import { ISourceActorProxy, SetBreakpointResult, Location } from '../actorProxy/source';
import { SourceMappingInfo } from "./info";
import { getUri } from "../../util/net";

const log = Log.create('SourceMappingSourceActorProxy');

export class SourceMappingSourceActorProxy implements ISourceActorProxy {

	public get name(): string {
		return this.source.actor;
	}

	public get url(): string {
		return this.source.url!;
	}

	public constructor(
		public readonly source: FirefoxDebugProtocol.Source,
		private readonly sourceMappingInfo: SourceMappingInfo
	) {}

	public async setBreakpoint(location: Location, condition: string): Promise<SetBreakpointResult> {

		if (log.isDebugEnabled) log.debug(`Computing generated location for ${this.url}:${location.line}:${location.column}`);
		let generatedLocation = this.sourceMappingInfo.generatedLocationFor({
			source: this.url, line: location.line, column: location.column || 0
		});
		if (log.isDebugEnabled) log.debug(`Got generated location ${generatedLocation.line}:${generatedLocation.column}`);

		const generatedLine = generatedLocation.line;
		if (generatedLine === null) {
			throw 'Couldn\'t find generated location';
		}

		let result = await this.sourceMappingInfo.underlyingSource.setBreakpoint(
			{ line: generatedLine, column: generatedLocation.column || undefined }, condition);
		let actualGeneratedLocation = result.actualLocation || generatedLocation;
		if (log.isDebugEnabled) log.debug(`Computing original location for ${actualGeneratedLocation.line}:${actualGeneratedLocation.column}`);
		let actualOriginalLocation = this.sourceMappingInfo.originalLocationFor({
			line: actualGeneratedLocation.line || 1,
			column: actualGeneratedLocation.column || 1
		});
		if (log.isDebugEnabled) log.debug(`Got original location ${actualOriginalLocation.line}:${actualOriginalLocation.column}`);

		result.actualLocation = {
			source: this.source,
			line: actualOriginalLocation.line || undefined,
			column: actualOriginalLocation.column || undefined
		};

		return result;
	}

	public async fetchSource(): Promise<FirefoxDebugProtocol.Grip> {
		if (log.isDebugEnabled) log.debug(`Fetching source for ${this.url}`);
		let embeddedSource = this.sourceMappingInfo.sourceMapConsumer!.sourceContentFor(this.url);
		if (embeddedSource) {
			if (log.isDebugEnabled) log.debug(`Got embedded source for ${this.url}`);
			return embeddedSource;
		} else {
			const source = await getUri(this.url);
			if (log.isDebugEnabled) log.debug(`Got non-embedded source for ${this.url}`);
			return source;
		}
	}

	public async setBlackbox(blackbox: boolean): Promise<void> {
		this.source.isBlackBoxed = blackbox;
		this.sourceMappingInfo.syncBlackboxFlag();
	}

	public dispose(): void {
		this.sourceMappingInfo.disposeSource(this);
	}
}
