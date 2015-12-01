declare namespace MozDebugProtocol {

	interface Request {
		to: string;
		type: string;
	}

	interface Response {
		from: string;
	}

	interface TypedResponse extends Response {
		type: string;
	}

	interface ErrorResponse extends Response {
		error: string;
		message: string;
	}

	interface InitialResponse extends Response {
		applicationType: string;
		traits?: any;
	}

	interface TabsResponse extends Response {
		tabs: Tab[];
		selected: number;
	}

	interface Tab {
		actor: string;
		title: string;
		url: string;
	}

	interface TabAttachedResponse extends TypedResponse {
		threadActor: string;
	}

	interface TabWillNavigateResponse extends TypedResponse {
		state: string;
		url: string;
	}

	interface TabDidNavigateResponse extends TypedResponse {
		state: string;
		url: string;
		title: string;
	}

	type Grip = boolean | number | string | ComplexGrip;

	interface ComplexGrip {
		type: string;
	}

	interface ObjectGrip extends ComplexGrip {
		class: string;
		actor: string;
	}

	interface FunctionGrip extends ObjectGrip {
		name?: string;
		displayName?: string;
		userDisplayName?: string;
		url?: string;
		line?: number;
		column?: number;
	}

	interface LongStringGrip extends ComplexGrip {
		initial: string;
		length: number;
		actor: string;
	}
}
