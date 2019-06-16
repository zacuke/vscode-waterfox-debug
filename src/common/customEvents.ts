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

export interface PopupAutohideEventBody {
	popupAutohide: boolean;
}
