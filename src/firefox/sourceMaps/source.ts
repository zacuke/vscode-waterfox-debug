import { ISourceActorProxy, SetBreakpointResult } from '../actorProxy/source';
import { SourceMappingInfo } from "./info";
import { getUri } from "../../util/net";

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

	public async setBreakpoint(location: { line: number, column?: number }, condition: string): Promise<SetBreakpointResult> {

		let generatedLocation = this.sourceMappingInfo.generatedLocationFor({
			source: this.url, line: location.line, column: location.column || 0
		});

		let result = await this.sourceMappingInfo.underlyingSource.setBreakpoint(generatedLocation, condition);
		let actualGeneratedLocation = result.actualLocation || generatedLocation;
		let actualOriginalLocation = this.sourceMappingInfo.originalLocationFor({
			line: actualGeneratedLocation.line || 1, 
			column: actualGeneratedLocation.column || 1
		});

		result.actualLocation = {
			source: this.source,
			line: actualOriginalLocation.line,
			column: actualOriginalLocation.column
		};

		return result;
	}

	public async fetchSource(): Promise<FirefoxDebugProtocol.Grip> {
		let embeddedSource = this.sourceMappingInfo.sourceMapConsumer!.sourceContentFor(this.url);
		if (embeddedSource) {
			return embeddedSource;
		} else {
			return await getUri(this.url);
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
