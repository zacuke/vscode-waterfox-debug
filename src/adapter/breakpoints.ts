import { Log } from '../util/log';
import { ThreadCoordinator, SourceAdapter, BreakpointAdapter, ThreadAdapter, Registry } from '../adapter/index';
import { DebugProtocol } from "vscode-debugprotocol";
import { Breakpoint, BreakpointEvent } from "vscode-debugadapter";

let log = Log.create('BreakpointsAdapter');

export class BreakpointsAdapter {

	private nextBreakpointId = 1;
	private breakpointsBySourcePath = new Map<string, BreakpointInfo[]>();
	private verifiedBreakpointSources: string[] = [];

	public constructor(
		private readonly threads: Registry<ThreadAdapter>,
		private readonly sendEvent: (ev: DebugProtocol.Event) => void
	) {}

	public setBreakpoints(args: DebugProtocol.SetBreakpointsArguments): Promise<{ breakpoints: DebugProtocol.Breakpoint[] }> {
		let breakpoints = args.breakpoints || [];
		log.debug(`Setting ${breakpoints.length} breakpoints for ${args.source.path}`);

		const sourcePath = args.source.path;
		if (sourcePath === undefined) {
			throw 'Couldn\'t set breakpoint: unknown source path';
		}

		let breakpointInfos = breakpoints.map((breakpoint) => <BreakpointInfo>{
			id: this.nextBreakpointId++,
			requestedLine: breakpoint.line,
			requestedColumn: breakpoint.column,
			condition: breakpoint.condition
		});

		this.breakpointsBySourcePath.set(sourcePath, breakpointInfos);
		this.verifiedBreakpointSources = this.verifiedBreakpointSources.filter(
			(verifiedSourcePath) => (verifiedSourcePath !== sourcePath));

		return new Promise<{ breakpoints: DebugProtocol.Breakpoint[] }>((resolve, reject) => {

			for (let [, threadAdapter] of this.threads) {

				let sourceAdapters = threadAdapter.findSourceAdaptersForPath(sourcePath);
				for (let sourceAdapter of sourceAdapters) {

					log.debug(`Found source ${sourcePath} on tab ${threadAdapter.actorName}`);

					let setBreakpointsPromise = this.setBreakpointsOnSourceActor(
						breakpointInfos, sourceAdapter, threadAdapter.coordinator);

					if (this.verifiedBreakpointSources.indexOf(sourcePath) < 0) {

						setBreakpointsPromise.then(
							(breakpointAdapters) => {

								log.debug('Replying to setBreakpointsRequest with actual breakpoints from the first thread with this source');
								resolve({
									breakpoints: breakpointAdapters.map(
										(breakpointAdapter) => {
											let breakpoint: DebugProtocol.Breakpoint =
												new Breakpoint(true,
												breakpointAdapter.breakpointInfo.actualLine,
												breakpointAdapter.breakpointInfo.actualColumn);
											breakpoint.id = breakpointAdapter.breakpointInfo.id;
											return breakpoint;
										})
								});
							});

						this.verifiedBreakpointSources.push(sourcePath);
					}
				}
			}

			if (this.verifiedBreakpointSources.indexOf(sourcePath) < 0) {
				log.debug (`Replying to setBreakpointsRequest (Source ${sourcePath} not seen yet)`);

				resolve({
					breakpoints: breakpointInfos.map((breakpointInfo) => {
						let breakpoint: DebugProtocol.Breakpoint =
							new Breakpoint(false, breakpointInfo.requestedLine, breakpointInfo.requestedColumn);
						breakpoint.id = breakpointInfo.id;
						return breakpoint;
					})
				});
			}
		});
	}

	public setBreakpointsOnNewSource(
		sourceAdapter: SourceAdapter,
		threadAdapter: ThreadAdapter
	): void {

		const sourcePath = sourceAdapter.sourcePath;
		if (sourcePath && this.breakpointsBySourcePath.has(sourcePath)) {

			let breakpointInfos = this.breakpointsBySourcePath.get(sourcePath) || [];

			if (sourceAdapter !== undefined) {

				let setBreakpointsPromise = this.setBreakpointsOnSourceActor(
					breakpointInfos, sourceAdapter, threadAdapter.coordinator);

				if (this.verifiedBreakpointSources.indexOf(sourcePath) < 0) {

					setBreakpointsPromise.then((breakpointAdapters) => {

						log.debug('Updating breakpoints');

						breakpointAdapters.forEach((breakpointAdapter) => {
							let breakpoint: DebugProtocol.Breakpoint =
								new Breakpoint(true, breakpointAdapter.breakpointInfo.actualLine);
							breakpoint.id = breakpointAdapter.breakpointInfo.id;
							this.sendEvent(new BreakpointEvent('update', breakpoint));
						})

						this.verifiedBreakpointSources.push(sourcePath);
					})
				}
			};
		}
	}

	private setBreakpointsOnSourceActor(
		breakpointsToSet: BreakpointInfo[],
		sourceAdapter: SourceAdapter,
		threadCoordinator: ThreadCoordinator
	): Promise<BreakpointAdapter[]> {

		if (sourceAdapter.hasCurrentBreakpoints()) {
			let currentBreakpoints = sourceAdapter.getCurrentBreakpoints()!;
			if (this.breakpointsAreEqual(breakpointsToSet, currentBreakpoints)) {
				return Promise.resolve(currentBreakpoints);
			}
		}

		return threadCoordinator.runOnPausedThread(() =>
			this.setBreakpointsOnPausedSourceActor(breakpointsToSet, sourceAdapter), undefined);
	}

	private setBreakpointsOnPausedSourceActor(origBreakpointsToSet: BreakpointInfo[],
	sourceAdapter: SourceAdapter): Promise<BreakpointAdapter[]> {

		// we will modify this array, so we make a (shallow) copy and work with that
		let breakpointsToSet = <(BreakpointInfo | undefined)[]>origBreakpointsToSet.slice();

		log.debug(`Setting ${breakpointsToSet.length} breakpoints for ${sourceAdapter.actor.url}`);

		let result = new Promise<BreakpointAdapter[]>((resolve, reject) => {

			sourceAdapter.getBreakpointsPromise().then(

				(oldBreakpoints) => {

					log.debug(`${oldBreakpoints.length} breakpoints were previously set for ${sourceAdapter.actor.url}`);

					let newBreakpoints: BreakpointAdapter[] = [];
					let breakpointsBeingRemoved: Promise<void>[] = [];
					let breakpointsBeingSet: Promise<void>[] = [];

					oldBreakpoints.forEach((breakpointAdapter) => {

						let breakpointIndex = -1;
						for (let i = 0; i < breakpointsToSet.length; i++) {
							let breakpointToSet = breakpointsToSet[i];
							if (breakpointToSet &&
								(breakpointToSet.requestedLine === breakpointAdapter.breakpointInfo.requestedLine) &&
								(breakpointToSet.requestedColumn === breakpointAdapter.breakpointInfo.requestedColumn)) {
								breakpointIndex = i;
								break;
							}
						}

						if (breakpointIndex >= 0) {
							newBreakpoints[breakpointIndex] = breakpointAdapter;
							breakpointsToSet[breakpointIndex] = undefined;
						} else {
							breakpointsBeingRemoved.push(
								breakpointAdapter.actor.delete().catch(
									(err) => {
										log.error(`Failed removing breakpoint: ${err}`);
									}
								));
						}
					});

					breakpointsToSet.map((requestedBreakpoint, index) => {
						if (requestedBreakpoint !== undefined) {

							breakpointsBeingSet.push(
								sourceAdapter.actor.setBreakpoint(
									{
										line: requestedBreakpoint.requestedLine,
										column: requestedBreakpoint.requestedColumn,
									},
									requestedBreakpoint.condition
								).then(

									(setBreakpointResult) => {

										requestedBreakpoint.actualLine =
											(setBreakpointResult.actualLocation === undefined) ?
											requestedBreakpoint.requestedLine :
											setBreakpointResult.actualLocation.line;
										requestedBreakpoint.actualColumn =
											(setBreakpointResult.actualLocation === undefined) ?
											requestedBreakpoint.requestedColumn :
											setBreakpointResult.actualLocation.column;

										newBreakpoints[index] = new BreakpointAdapter(
											requestedBreakpoint, setBreakpointResult.breakpointActor);
									},
									(err) => {
										log.error(`Failed setting breakpoint: ${err}`);
									}));
						}
					});

					log.debug(`Adding ${breakpointsBeingSet.length} and removing ${breakpointsBeingRemoved.length} breakpoints`);

					Promise.all(breakpointsBeingRemoved).then(() =>
					Promise.all(breakpointsBeingSet)).then(() => {
						resolve(newBreakpoints);
					});

				});
		});

		sourceAdapter.setBreakpointsPromise(result);
		return result;
	}

	private breakpointsAreEqual(
		breakpointsToSet: BreakpointInfo[],
		currentBreakpoints: BreakpointAdapter[]
	): boolean {

		let breakpointsToSetLines = new Set(breakpointsToSet.map(
			(breakpointInfo) => breakpointInfo.requestedLine));
		let currentBreakpointsLines = new Set(currentBreakpoints.map(
			(breakpointAdapter) => breakpointAdapter.breakpointInfo.requestedLine));

		if (breakpointsToSetLines.size !== currentBreakpointsLines.size) {
			return false;
		}

		for (let line of breakpointsToSetLines.keys()) {
			if (!currentBreakpointsLines.has(line)) {
				return false;
			}
		}

		return true;
	}
}

export class BreakpointInfo {
	id: number;
	requestedLine: number;
	requestedColumn: number | undefined;
	actualLine: number | undefined;
	actualColumn: number | undefined;
	condition: string | undefined;
}
