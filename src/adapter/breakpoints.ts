import { Log } from '../util/log';
import { DebugProtocol } from 'vscode-debugprotocol';
import { ThreadCoordinator, SourceAdapter, BreakpointAdapter } from '../adapter/index';

let log = Log.create('BreakpointsAdapter');

export class BreakpointsAdapter {

	public static setBreakpointsOnSourceActor(breakpointsToSet: BreakpointInfo[], 
	sourceAdapter: SourceAdapter, threadCoordinator: ThreadCoordinator): Promise<BreakpointAdapter[]> {
		return threadCoordinator.runOnPausedThread((finished) => 
			this.setBreakpointsOnPausedSourceActor(breakpointsToSet, sourceAdapter, finished), false);
	}

	private static setBreakpointsOnPausedSourceActor(origBreakpointsToSet: BreakpointInfo[], 
	sourceAdapter: SourceAdapter, finished: () => void): Promise<BreakpointAdapter[]> {

		// we will modify this array, so we make a (shallow) copy and work with that
		let breakpointsToSet = origBreakpointsToSet.slice();

		log.debug(`Setting ${breakpointsToSet.length} breakpoints for ${sourceAdapter.actor.url}`);

		let result = new Promise<BreakpointAdapter[]>((resolve, reject) => {

			sourceAdapter.currentBreakpoints.then(

				(oldBreakpoints) => {

					log.debug(`${oldBreakpoints.length} breakpoints were previously set for ${sourceAdapter.actor.url}`);

					let newBreakpoints: BreakpointAdapter[] = [];
					let breakpointsBeingRemoved: Promise<void>[] = [];
					let breakpointsBeingSet: Promise<void>[] = [];

					oldBreakpoints.forEach((breakpointAdapter) => {

						let breakpointIndex = -1;
						for (let i = 0; i < breakpointsToSet.length; i++) {
							if ((breakpointsToSet[i] !== undefined) && 
								(breakpointsToSet[i].requestedLine === breakpointAdapter.breakpointInfo.requestedLine)) {
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

							breakpointsBeingSet.push(sourceAdapter.actor.setBreakpoint(
								{ line: requestedBreakpoint.requestedLine }, 
								requestedBreakpoint.condition).then(
									
									(setBreakpointResult) => {

										requestedBreakpoint.actualLine = 
											(setBreakpointResult.actualLocation === undefined) ? 
											requestedBreakpoint.requestedLine : 
											setBreakpointResult.actualLocation.line;
											
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
						finished();
					});

				},
				(err) => {
					finished();
					throw err;
				});
		});
		
		sourceAdapter.currentBreakpoints = result;
		return result;
	}

}

export class BreakpointInfo {
	id: number;
	requestedLine: number;
	actualLine: number;
	condition: string;
}
