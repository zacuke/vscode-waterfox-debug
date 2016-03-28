import { Log } from '../util/log';
import { DebugProtocol } from 'vscode-debugprotocol';
import { ThreadActorProxy } from '../firefox/index';
import { SourceAdapter, BreakpointAdapter } from '../adapter/index';

let log = Log.create('BreakpointsAdapter');

export class BreakpointsAdapter {

	public static setBreakpointsOnSourceActor(breakpointsToSet: BreakpointInfo[], sourceAdapter: SourceAdapter, threadActor: ThreadActorProxy): Promise<BreakpointAdapter[]> {
		return threadActor.runOnPausedThread((finished) => 
			this.setBreakpointsOnPausedSourceActor(breakpointsToSet, sourceAdapter, finished));
	}

	private static setBreakpointsOnPausedSourceActor(breakpointsToSet: BreakpointInfo[], sourceAdapter: SourceAdapter, finished: () => void): Promise<BreakpointAdapter[]> {

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
							breakpointsBeingRemoved.push(breakpointAdapter.actor.delete());
						}
					});

					breakpointsToSet.map((requestedBreakpoint, index) => {
						if (requestedBreakpoint !== undefined) {

							breakpointsBeingSet.push(
								sourceAdapter.actor
								.setBreakpoint({ line: requestedBreakpoint.requestedLine }, requestedBreakpoint.condition)
								.then((setBreakpointResult) => {

									requestedBreakpoint.actualLine = 
										(setBreakpointResult.actualLocation === undefined) ? 
										requestedBreakpoint.requestedLine : 
										setBreakpointResult.actualLocation.line;
										
									newBreakpoints[index] = new BreakpointAdapter(requestedBreakpoint, setBreakpointResult.breakpointActor);
								}));
						}
					});
					
					log.debug(`Adding ${breakpointsBeingSet.length} and removing ${breakpointsBeingRemoved.length} breakpoints`);

					Promise.all(breakpointsBeingRemoved).then(() => 
					Promise.all(breakpointsBeingSet)).then(
						() => {
							resolve(newBreakpoints);
							finished();
						},
						(err) => {
							log.error(`Failed setting breakpoints: ${err}`);
							reject(err);
							finished();
						});
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
