import { ISourceActorProxy } from '../firefox/index';
import { DebugProtocol } from 'vscode-debugprotocol';
import { Source } from 'vscode-debugadapter';
import { ThreadAdapter, Registry, BreakpointInfo, BreakpointAdapter } from './index';

const actorIdRegex = /[0-9]+$/;

export class SourceAdapter {

	public readonly id: number;
	public readonly source: Source;

	private currentBreakpoints: BreakpointAdapter[] = [];
	private desiredBreakpoints: BreakpointInfo[] | undefined = undefined;
	private isSyncingBreakpoints: boolean = false;

	public constructor(
		sourceRegistry: Registry<SourceAdapter>,
		public actor: ISourceActorProxy,
		public readonly sourcePath: string | undefined,
		private readonly threadAdapter: ThreadAdapter
	) {
		this.id = sourceRegistry.register(this);
		this.source = SourceAdapter.createSource(actor, sourcePath, this.id);
	}

	private static createSource(
		actor: ISourceActorProxy,
		sourcePath: string | undefined,
		id: number
	): Source {

		let sourceName = '';
		if (actor.url != null) {
			sourceName = actor.url.split('/').pop()!.split('#')[0];
		} else {
			let match = actorIdRegex.exec(actor.name);
			if (match) {
				sourceName = `${actor.source.introductionType || 'Script'} ${match[0]}`;
			}
		}

		let source: Source;
		if (sourcePath !== undefined) {
			source = new Source(sourceName, sourcePath);
		} else {
			source = new Source(sourceName, actor.url || undefined, id);
		}

		if (actor.source.isBlackBoxed) {
			(<DebugProtocol.Source>source).presentationHint = 'deemphasize';
		}

		return source;
	}

	public updateBreakpoints(breakpoints: BreakpointInfo[]): void {
		this.desiredBreakpoints = breakpoints;
		this.checkAndSyncBreakpoints();
	}

	private checkAndSyncBreakpoints(): void {
		if ((this.desiredBreakpoints !== undefined) && !this.isSyncingBreakpoints) {
			this.threadAdapter.coordinator.runOnPausedThread(() => this.syncBreakpoints());
		}
	}

	private async syncBreakpoints(): Promise<void> {

		this.isSyncingBreakpoints = true;
		const desiredBreakpoints = this.desiredBreakpoints!;
		this.desiredBreakpoints = undefined;


		const breakpointsToDelete: BreakpointAdapter[] = [];
		const breakpointsToKeep: BreakpointAdapter[] = [];
		for (const currentBreakpoint of this.currentBreakpoints) {
			if (desiredBreakpoints.some(
				requestedBreakpoint => requestedBreakpoint.isEquivalent(currentBreakpoint.breakpointInfo)
			)) {
				breakpointsToKeep.push(currentBreakpoint);
			} else {
				breakpointsToDelete.push(currentBreakpoint);
			}
		}

		const deletionPromises = breakpointsToDelete.map(
			breakpointAdapter => breakpointAdapter.actor.delete()
		);

		await Promise.all(deletionPromises);


		const breakpointsToAdd = desiredBreakpoints.filter(
			desiredBreakpoint => !this.currentBreakpoints.some(
				currentBreakpoint => desiredBreakpoint.isEquivalent(currentBreakpoint.breakpointInfo)
			)
		);

		const additionPromises = breakpointsToAdd.map(
			breakpointInfo => this.actor.setBreakpoint({ 
				line: breakpointInfo.requestedBreakpoint.line,
				column: breakpointInfo.requestedBreakpoint.column
			}, breakpointInfo.requestedBreakpoint.condition)
		);

		const additionResults = await Promise.all(additionPromises);

		const breakpointsManager = this.threadAdapter.debugSession.breakpointsManager;

		const addedBreakpoints = additionResults.map(
			(setBreakpointResult, index) => {

				const desiredBreakpoint = breakpointsToAdd[index];
				const actualLocation = setBreakpointResult.actualLocation;
				const actualLine = actualLocation ? actualLocation.line : desiredBreakpoint.requestedBreakpoint.line;
				const actualColumn = actualLocation ? actualLocation.column : desiredBreakpoint.requestedBreakpoint.column;

				breakpointsManager.verifyBreakpoint(desiredBreakpoint, actualLine, actualColumn);

				return new BreakpointAdapter(desiredBreakpoint, setBreakpointResult.breakpointActor);
			}
		);


		this.currentBreakpoints = breakpointsToKeep.concat(addedBreakpoints);
		this.isSyncingBreakpoints = false;

		this.checkAndSyncBreakpoints();
	}

	public dispose(): void {
		this.actor.dispose();
	}
}
