import { ISourceActorProxy, SetBreakpointResult } from '../actorProxy/source';
import { SourceMappingInfo } from "./info";
import { getUri } from "../../util/misc";

export class SourceMappingSourceActorProxy implements ISourceActorProxy {

	public get name(): string {
		return this.source.actor;
	}

	public get url(): string {
		return this.source.url!;
	}

	public constructor(
		public readonly source: FirefoxDebugProtocol.Source,
		private readonly underlyingSourceActor: ISourceActorProxy,
		private readonly sourceMappingInfo: SourceMappingInfo
	) {}

	public async setBreakpoint(location: { line: number, column?: number }, condition: string): Promise<SetBreakpointResult> {

		let generatedLocation = this.sourceMappingInfo.generatedLocationFor({
			source: this.url, line: location.line, column: location.column || 0
		});

		let result = await this.underlyingSourceActor.setBreakpoint(generatedLocation, condition);

		if (result.actualLocation) {

			result.actualLocation.source = this.source;

			if (result.actualLocation.line) {

				let originalLocation = this.sourceMappingInfo.originalLocationFor({
					line: result.actualLocation.line, 
					column: result.actualLocation.column || 0
				});

				result.actualLocation.line = originalLocation.line;
				result.actualLocation.column = originalLocation.column;
			}
		}

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
		//TODO
		throw new Error('Not implemented yet');
	}

	public dispose(): void {
		//TODO
	}
}
