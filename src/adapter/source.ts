import { Log } from '../util/log';
import { ISourceActorProxy } from '../firefox/index';
import { DebugProtocol } from 'vscode-debugprotocol';
import { Source } from 'vscode-debugadapter';
import { ThreadAdapter, Registry, BreakpointInfo, BreakpointAdapter } from './index';
import { OldProtocolBreakpointAdapter, NewProtocolBreakpointAdapter } from './misc';

const log = Log.create('SourceAdapter');

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
		public readonly threadAdapter: ThreadAdapter,
		private readonly newBreakpointProtocol: boolean
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

	public findBreakpointAdapterForActorName(actorName: string): BreakpointAdapter | undefined {
		return this.currentBreakpoints.find(
			breakpointAdapter => (breakpointAdapter.actorName === actorName)
		);
	}

	private checkAndSyncBreakpoints(): void {
		if ((this.desiredBreakpoints !== undefined) && !this.isSyncingBreakpoints) {
			if (this.newBreakpointProtocol) {
				this.syncBreakpoints();
			} else {
				this.threadAdapter.coordinator.runOnPausedThread(() => this.syncBreakpoints());
			}
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

		if (log.isDebugEnabled) log.debug(`Going to delete ${breakpointsToDelete.length} breakpoints`);

		const deletionPromises = breakpointsToDelete.map(
			breakpointAdapter => breakpointAdapter.delete()
		);

		await Promise.all(deletionPromises);


		const breakpointsToAdd = desiredBreakpoints.filter(
			desiredBreakpoint => !this.currentBreakpoints.some(
				currentBreakpoint => desiredBreakpoint.isEquivalent(currentBreakpoint.breakpointInfo)
			)
		);

		if (log.isDebugEnabled) log.debug(`Going to add ${breakpointsToAdd.length} breakpoints`);

		let addedBreakpoints: BreakpointAdapter[];
		if (this.newBreakpointProtocol) {

			const breakpointPositions = await this.actor.getBreakpointPositions();

			const additionPromises = breakpointsToAdd.map(
				async breakpointInfo => {

					const actualLocation = this.findBreakpointPosition(
						breakpointInfo.requestedBreakpoint.line,
						breakpointInfo.requestedBreakpoint.column || 0,
						breakpointPositions
					);
					breakpointInfo.actualLine = actualLocation.line;
					breakpointInfo.actualColumn = actualLocation.column;

					await this.threadAdapter.actor.setBreakpoint(
						breakpointInfo.actualLine,
						breakpointInfo.actualColumn,
						this.actor.url!
					);
				}
			);
	
			await Promise.all(additionPromises);
	
			const breakpointsManager = this.threadAdapter.debugSession.breakpointsManager;
	
			addedBreakpoints = breakpointsToAdd.map(
				breakpointInfo => {
	
					breakpointsManager.verifyBreakpoint(
						breakpointInfo, 
						breakpointInfo.actualLine,
						breakpointInfo.actualColumn
					);
	
					return new NewProtocolBreakpointAdapter(breakpointInfo, this);
				}
			);

		} else {

			const additionPromises = breakpointsToAdd.map(
				breakpointInfo => this.actor.setBreakpoint({ 
					line: breakpointInfo.requestedBreakpoint.line,
					column: breakpointInfo.requestedBreakpoint.column
				}, breakpointInfo.requestedBreakpoint.condition)
			);
	
			const additionResults = await Promise.all(additionPromises);
	
			const breakpointsManager = this.threadAdapter.debugSession.breakpointsManager;
	
			addedBreakpoints = additionResults.map(
				(setBreakpointResult, index) => {
	
					const desiredBreakpoint = breakpointsToAdd[index];
					const actualLocation = setBreakpointResult.actualLocation;
					const actualLine = actualLocation ? actualLocation.line : desiredBreakpoint.requestedBreakpoint.line;
					const actualColumn = actualLocation ? actualLocation.column : desiredBreakpoint.requestedBreakpoint.column;
	
					breakpointsManager.verifyBreakpoint(desiredBreakpoint, actualLine, actualColumn);
	
					return new OldProtocolBreakpointAdapter(desiredBreakpoint, setBreakpointResult.breakpointActor);
				}
			);
		}


		this.currentBreakpoints = breakpointsToKeep.concat(addedBreakpoints);
		this.isSyncingBreakpoints = false;

		this.checkAndSyncBreakpoints();
	}

	private findBreakpointPosition(
		requestedLine: number,
		requestedColumn: number,
		breakpointPositions: FirefoxDebugProtocol.BreakpointPositions
	): { line: number, column: number } {

		let line = Number.MAX_SAFE_INTEGER;
		let lastLine = 0;
		for (const l in breakpointPositions) {
			const possibleLine = parseInt(l);
			if ((possibleLine >= requestedLine) && (possibleLine < line)) {
				line = possibleLine;
			}
			if (possibleLine > lastLine) {
				lastLine = possibleLine;
			}
		}

		if (line === Number.MAX_SAFE_INTEGER) {
			line = lastLine;
		}

		if (line === requestedLine) {
			for (const column of breakpointPositions[line]) {
				if (column >= requestedColumn) {
					return { line, column };
				}
			}
		}

		const column = breakpointPositions[line][0];
		return { line, column };
	}

	public dispose(): void {
		this.actor.dispose();
	}
}
