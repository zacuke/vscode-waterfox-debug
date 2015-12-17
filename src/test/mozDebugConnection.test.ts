import { MozDebugConnection } from '../mozilla/mozDebugConnection';
import { ThreadActorProxy, PauseActorProxy } from '../mozilla/actorProxy';

let con = new MozDebugConnection();
con.rootActor.onInit(r => console.log('Running in ' + r.applicationType));
con.rootActor.onTabOpened(t => {
	console.log('Tab ' + t.url + ' opened');
	t.attach().then((threadActor) => {
		threadActor.attach().then(() => {
			threadActor.fetchSources().then((sourceActors) => {
				let testSourceActor = sourceActors.filter((sourceActor) => sourceActor.url == 'file:///home/marvin/Misc/projects/chrome-debug-test/test.js');
				if (testSourceActor.length > 0) {
					testSourceActor[0].setBreakpoint({ line: 0 }).then((actualLocation) => {
						console.log('Actual breakpoint location: ' + actualLocation.line + " , " + actualLocation.column);
						threadActor.resume();
					});
				}
			});
		});
	});
});
con.rootActor.onTabClosed(t => {
	console.log('Tab ' + t.url + ' closed');
});
con.rootActor.fetchTabs();
