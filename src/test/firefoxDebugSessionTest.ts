import { Log } from '../util/log';
import { DebugConnection } from '../firefox/connection';
import { ThreadActorProxy, PauseActorProxy } from '../firefox/index';

let con = new DebugConnection();
con.rootActor.onInit(r => Log.debug('Running in ' + r.applicationType));
con.rootActor.onTabOpened(t => {
	Log.info('Tab ' + t.url + ' opened');
	t.attach().then((threadActor) => {
		threadActor.fetchSources().then((sourceActors) => {
			let testSourceActor = sourceActors.filter((sourceActor) => sourceActor.url == 'file:///home/marvin/Misc/projects/chrome-debug-test/test.js');
			if (testSourceActor.length > 0) {
				testSourceActor[0].setBreakpoint({ line: 0 }).then((setBreakpointResult) => {
					Log.info('Actual breakpoint location: ' + setBreakpointResult.actualLocation.line + 
						" , " + setBreakpointResult.actualLocation.column);
					threadActor.onPaused(() => {
						threadActor.fetchStackFrames().then((frames) => {
							Log.debug('Frames:\n' + JSON.stringify(frames));
							threadActor.resume();
						});
					});
					threadActor.resume();
				});
			}
		});
	});
});
con.rootActor.onTabClosed(t => {
	Log.info('Tab ' + t.url + ' closed');
});
con.rootActor.onTabListChanged(() => con.rootActor.fetchTabs());
con.rootActor.fetchTabs();
