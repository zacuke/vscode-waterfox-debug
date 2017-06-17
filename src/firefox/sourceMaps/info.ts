import { ISourceActorProxy } from '../index';
import { SourceMapConsumer, Position, MappedPosition } from 'source-map';

let LEAST_UPPER_BOUND = (<any>SourceMapConsumer).LEAST_UPPER_BOUND;
let GREATEST_LOWER_BOUND = (<any>SourceMapConsumer).GREATEST_LOWER_BOUND;

export class SourceMappingInfo {

	public constructor(
		public readonly sources: ISourceActorProxy[],
		public readonly underlyingSource: ISourceActorProxy,
		public readonly sourceMapUri?: string,
		public readonly sourceMapConsumer?: SourceMapConsumer
	) {}

	public generatedLocationFor(originalLocation: MappedPosition): Position {

		if (!this.sourceMapConsumer) {
			return { line: originalLocation.line, column: originalLocation.column };
		}

		let consumerArgs = Object.assign({ bias: LEAST_UPPER_BOUND }, originalLocation);
		let generatedLocation = this.sourceMapConsumer.generatedPositionFor(consumerArgs);

		if (generatedLocation.line === null) {
			consumerArgs.bias = GREATEST_LOWER_BOUND;
			generatedLocation = this.sourceMapConsumer.generatedPositionFor(consumerArgs);
		}

		return generatedLocation;
	}

	public originalLocationFor(generatedLocation: Position): MappedPosition {

		if (!this.sourceMapConsumer) {
			return Object.assign({ source: this.sources[0]!.url! }, generatedLocation);
		}

		let consumerArgs = Object.assign({ bias: LEAST_UPPER_BOUND }, generatedLocation);
		let originalLocation = this.sourceMapConsumer.originalPositionFor(consumerArgs);

		if (originalLocation.line === null) {
			consumerArgs.bias = GREATEST_LOWER_BOUND;
			originalLocation = this.sourceMapConsumer.originalPositionFor(consumerArgs);
		}

		return originalLocation;
	}

	public syncBlackboxFlag(): void {

		if ((this.sources.length === 1) && (this.sources[0] === this.underlyingSource)) {
			return;
		}

		let blackboxUnderlyingSource = this.sources.every((source) => source.source.isBlackBoxed);
		if (this.underlyingSource.source.isBlackBoxed !== blackboxUnderlyingSource) {
			this.underlyingSource.setBlackbox(blackboxUnderlyingSource);
		}
	}

	public disposeSource(source: ISourceActorProxy): void {

		let sourceIndex = this.sources.indexOf(source);
		if (sourceIndex >= 0) {

			this.sources.splice(sourceIndex, 1);

			if (this.sources.length === 0) {
				this.underlyingSource.dispose();
			}
		}
	}
}
