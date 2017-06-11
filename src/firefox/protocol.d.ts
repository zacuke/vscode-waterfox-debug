declare namespace FirefoxDebugProtocol {

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
		preferenceActor: string;
		addonsActor: string;
	}

	interface Tab {
		actor: string;
		title: string;
		url: string;
		consoleActor: string;
	}

	interface AddonsResponse extends Response {
		addons: Addon[];
	}

	interface Addon {
		actor: string;
		id: string;
		name: string;
		url?: string;
		consoleActor: string;
		iconUrl?: string;
		debuggable?: boolean;
		traits: {
			highlightable: boolean;
			networkMonitor: boolean;
		}
	}

	interface InstallAddonResponse extends Response {
		addon: {
			id: string,
			actor: boolean
		};
	}

	interface ProcessResponse extends Response {
		form: {
			actor: string;
			url: string;
			consoleActor: string;
		}
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

	interface WorkersResponse extends Response {
		workers: Worker[];
	}

	interface Worker {
		actor: string;
		url: string;
		type: number;
	}

	interface WorkerAttachedResponse extends TypedResponse {
		url: string;
	}

	interface WorkerConnectedResponse extends TypedResponse {
		threadActor: string;
		consoleActor: string;
	}

	interface PageErrorResponse extends TypedResponse {
		pageError: PageErrorResponseBody;
	}

	interface PageErrorResponseBody {
		errorMessage: string;
		sourceName: string;
		lineText: string;
		lineNumber: number;
		columnNumber: number;
		category: string;
		timeStamp: number;
		info: boolean;
		warning: boolean;
		error: boolean;
		exception: boolean;
		strict: boolean;
		private: boolean;
		stacktrace: {
			filename: string;
			functionname: string;
			line: number;
			column: number;
		}[];
	}

	interface ConsoleAPICallResponse extends TypedResponse {
		message: ConsoleAPICallResponseBody;
	}

	interface ConsoleAPICallResponseBody {
		arguments: Grip[];
		filename: string;
		functionName: string;
		groupName: string;
		lineNumber: number;
		columnNumber: number;
		category: string;
		timeStamp: number;
		level: string;
		workerType: string;
		private: boolean;
		styles: any[]; //?
		counter: any; //?
		timer: any; //?
	}

	interface LogMessageResponse extends TypedResponse {
		message: string;
		timeStamp: number;
	}

	interface ResultIDResponse extends Response {
		resultID: number;
	}

	interface EvaluationResultResponse extends TypedResponse {
		input: string;
		resultID: number;
		result: Grip;
		exception?: Grip | null;
		exceptionMessage?: string;
		exceptionDocURL?: string;
		timestamp: number;
		helperResult: any; //?
	}

	interface AutoCompleteResponse extends Response {
		matches: string[];
		matchProp: string;
	}

	interface ThreadPausedResponse extends TypedResponse {
		actor: string;
		frame: Frame;
		poppedFrames: Frame[];
		why: ThreadPausedReason;
	}

	interface ThreadPausedReason {
		type: 'attached' | 'interrupted' | 'resumeLimit' | 'debuggerStatement' | 'breakpoint' | 
			'watchpoint' | 'clientEvaluated' | 'pauseOnDOMEvents' | 'alreadyPaused' | 'exception';
		frameFinished?: CompletionValue; // if type is 'resumeLimit' or 'clientEvaluated'
		exception?: Grip; // if type is 'exception'
		actors?: string[]; // if type is 'breakpoint' or 'watchpoint'
	}

	interface SetBreakpointResponse extends Response {
		actor: string;
		isPending: boolean;
		actualLocation?: SourceLocation;
	}

	interface PrototypeAndPropertiesResponse extends TypedResponse {
		prototype: ObjectGrip | { type: 'null' };
		ownProperties: PropertyDescriptors;
		safeGetterValues?: SafeGetterValueDescriptors;
	}

	interface CompletionValue {
		return?: Grip;
		throw?: Grip;
		terminated?: boolean;
	}

	interface Frame {
		type: 'global' | 'call' | 'eval' | 'clientEvaluate';
		actor: string;
		depth: number;
		this: Grip;
		where: SourceLocation;
		environment: Environment;
	}

	interface GlobalFrame extends Frame {
		source: Source;
	}

	interface CallFrame extends Frame {
		callee: Grip;
		arguments: Grip[];
	}

	interface EvalFrame extends Frame {
	}

	interface ClientEvalFrame extends Frame {
	}

	interface SourceLocation {
		source: Source;
		line?: number;
		column?: number;
	}

	interface Source {
		actor: string;
		url: string | null;
		introductionType?: 'scriptElement' | 'eval' | 'Function' | 'debugger eval' | null;
		introductionUrl: string | null;
		isBlackBoxed: boolean;
		isPrettyPrinted: boolean;
		isSourceMapped: boolean;
		generatedUrl: string | null;
		sourceMapURL: string | null;
		addonID?: string;
		addonPath?: string;
	}

	interface Environment {
		type: 'object' | 'function' | 'with' | 'block';
		actor: string;
		parent?: Environment;
	}

	interface ObjectEnvironment extends Environment {
		object: Grip;
	}

	interface FunctionEnvironment extends Environment {
		function: Grip;
		bindings: FunctionBindings;
	}

	interface WithEnvironment extends Environment {
		object: Grip;
	}

	interface BlockEnvironment extends Environment {
		bindings: Bindings;
	}

	interface Bindings {
		variables: PropertyDescriptors;
	}

	interface FunctionBindings extends Bindings {
		arguments: PropertyDescriptors[];
	}

	interface PropertyDescriptor {
		enumerable: boolean;
		configurable: boolean;
	}

	interface DataPropertyDescriptor extends PropertyDescriptor {
		value: Grip;
		writeable: boolean;
	}

	interface AccessorPropertyDescriptor extends PropertyDescriptor {
		get: Grip;
		set: Grip;
	}

	interface SafeGetterValueDescriptor {
		getterValue: Grip;
		getterPrototypeLevel: number;
		enumerable: boolean;
		writable: boolean;
	}

	interface PropertyDescriptors {
		[name: string]: PropertyDescriptor;
	}

	interface SafeGetterValueDescriptors {
		[name: string]: SafeGetterValueDescriptor;
	}

	type Grip = boolean | number | string | ComplexGrip;

	interface ComplexGrip {
		type: 'null' | 'undefined' | 'Infinity' | '-Infinity' | 'NaN' | '-0' | 'longString' | 'symbol' | 'object';
	}

	interface ObjectGrip extends ComplexGrip {
		class: string;
		actor: string;
		preview?: any; //TODO
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

	interface SymbolGrip extends ComplexGrip {
		name: string;
	}
}
