import { Log } from '../util/log';
import { ISourceActorProxy } from '../firefox/actorProxy/source';
import { DebugProtocol } from 'vscode-debugprotocol';
import { Source } from 'vscode-debugadapter';
import { ThreadAdapter } from './thread';
import { Registry } from './registry';
import { BreakpointInfo, BreakpointAdapter, OldProtocolBreakpointAdapter, NewProtocolBreakpointAdapter } from './breakpoint';
import { findNextBreakpointPosition } from '../firefox/sourceMaps/info';

const log = Log.create('SourceAdapter');

const actorIdRegex = /[0-9]+$/;

/**
 * Adapter class for a javascript source.
 */
export class SourceAdapter {

	public readonly id: number;
	public readonly source: Source;
	public get actor(): ISourceActorProxy {
		return this._actor;
	}

	/** the breakpoints for this source that have been set in Firefox */
	private currentBreakpoints: BreakpointAdapter[] = [];

	/** the breakpoints for this source that should be set in Firefox */
	private desiredBreakpoints: BreakpointInfo[] | undefined = undefined;

	/** `true` while `syncBreakpoints()` is running  */
	private isSyncingBreakpoints: boolean = false;

	public constructor(
		sourceRegistry: Registry<SourceAdapter>,
		private _actor: ISourceActorProxy,
		/** the path or url as seen by VS Code */
		public readonly sourcePath: string | undefined,
		public readonly threadAdapter: ThreadAdapter,
		private readonly newBreakpointProtocol: boolean
	) {
		this.id = sourceRegistry.register(this);
		this.source = SourceAdapter.createSource(_actor, sourcePath, this.id);
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

	public async replaceActor(newActor: ISourceActorProxy): Promise<void> {

		await Promise.all(this.currentBreakpoints.map(breakpoint => breakpoint.delete()));

		this._actor = newActor;

		this.desiredBreakpoints = this.currentBreakpoints.map(bp => bp.breakpointInfo);
		this.currentBreakpoints = [];
		this.checkAndSyncBreakpoints();
	}

	public findBreakpointAdapterForActorName(actorName: string): BreakpointAdapter | undefined {
		return this.currentBreakpoints.find(
			breakpointAdapter => (breakpointAdapter.actorName === actorName)
		);
	}

	public findBreakpointAdapterForLocation(location: FirefoxDebugProtocol.SourceLocation): BreakpointAdapter | undefined {
		return this.currentBreakpoints.find(
			breakpointAdapter => 
				(breakpointAdapter.breakpointInfo.actualLine === location.line) &&
				(breakpointAdapter.breakpointInfo.actualColumn === location.column)
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

	/**
	 * synchronize the breakpoints for this source with Firefox, i.e. calculate the difference
	 * between `currentBreakpoints` and `desiredBreakpoints` and add and remove breakpoints as needed
	 */
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

					const actualLocation = findNextBreakpointPosition(
						breakpointInfo.requestedBreakpoint.line,
						breakpointInfo.requestedBreakpoint.column || 0,
						breakpointPositions
					);
					breakpointInfo.actualLine = actualLocation.line;
					breakpointInfo.actualColumn = actualLocation.column;

					let logValue: string | undefined;
					if (breakpointInfo.requestedBreakpoint.logMessage) {
						logValue = '...' + convertLogpointMessage(breakpointInfo.requestedBreakpoint.logMessage);
					}

					await this.threadAdapter.actor.setBreakpoint(
						breakpointInfo.actualLine,
						breakpointInfo.actualColumn,
						this.actor.url!,
						breakpointInfo.requestedBreakpoint.condition,
						logValue
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

	public dispose(): void {
		this.actor.dispose();
	}
}

/**
 * convert the message of a logpoint (which can contain javascript expressions in curly braces)
 * to a javascript expression that evaluates to an array of values to be displayed in the debug console
 * (doesn't support escaping or nested curly braces)
 */
export function convertLogpointMessage(msg: string): string {

	// split `msg` into string literals and javascript expressions
	const items: string[] = [];
	let currentPos = 0;
	while (true) {

		const leftBrace = msg.indexOf('{', currentPos);

		if (leftBrace < 0) {

			items.push(JSON.stringify(msg.substring(currentPos)));
			break;

		} else {

			let rightBrace = msg.indexOf('}', leftBrace + 1);
			if (rightBrace < 0) rightBrace = msg.length;

			items.push(JSON.stringify(msg.substring(currentPos, leftBrace)));
			items.push(msg.substring(leftBrace + 1, rightBrace));
			currentPos = rightBrace + 1;
		}
	}

	// the appended `reduce()` call will convert all non-object values to strings and concatenate consecutive strings
	return `[${items.join(',')}].reduce((a,c)=>{if(typeof c==='object'&&c){a.push(c,'')}else{a.push(a.pop()+c)}return a},[''])`;
}
