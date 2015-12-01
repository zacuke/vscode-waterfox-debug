import { MozDebugConnection } from '../mozilla/mozDebugConnection';

let con = new MozDebugConnection();
con.rootActor.onInit(r => console.log('Running in ' + r.applicationType));
con.rootActor.onTabOpened(t => {
	console.log('Tab ' + t.url + ' opened');
	t.onAttached(th => console.log('Thread ' + th.name));
	t.onDetached(() => console.log('Tab ' + t.url + ' closed'));
	t.onDidNavigate(() => console.log('Navigated to ' + t.url));
	t.attach();
});
con.rootActor.onTabClosed(t => {
	console.log('Tab ' + t.url + ' closed');
});
con.rootActor.fetchTabs();
