import * as vscode from 'vscode';
import { LoadedScriptsProvider } from './loadedScripts';

export interface ThreadStartedEventBody {
	name: string;
	id: number;
}

export interface ThreadExitedEventBody {
	id: number;
}

export interface NewSourceEventBody {
	threadId: number;
	sourceId: number;
	url: string | undefined;
	path: string | undefined;
}

export interface RemoveSourcesEventBody {
	threadId: number;
}

export function onCustomEvent(
	event: vscode.DebugSessionCustomEvent,
	loadedScriptsProvider: LoadedScriptsProvider
) {
	if (event.session.type === 'firefox') {

		switch (event.event) {

			case 'threadStarted':
				loadedScriptsProvider.addThread(<ThreadStartedEventBody>event.body, event.session.id);
				break;

			case 'threadExited':
				loadedScriptsProvider.removeThread((<ThreadExitedEventBody>event.body).id, event.session.id);
				break;

			case 'newSource':
				loadedScriptsProvider.addSource(<NewSourceEventBody>event.body, event.session.id);
				break;

			case 'removeSources':
				loadedScriptsProvider.removeSources((<RemoveSourcesEventBody>event.body).threadId, event.session.id);
				break;
		}
	}
}
