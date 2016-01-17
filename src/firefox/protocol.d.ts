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

	interface ThreadPausedResponse extends TypedResponse {
		actor: string;
		poppedFrames: Frame[];
		why: {
			type: string;
			frameFinished?: CompletionValue; // if type is 'resumeLimit' or 'clientEvaluated'
			actors?: string[]; // if type is 'breakpoint' or 'watchpoint'
		};
	}
	
	interface SetBreakpointResponse extends Response {
		actor: string;
		isPending: boolean;
		actualLocation?: SourceLocation;
	}
	
	interface PrototypeAndPropertiesResponse extends TypedResponse {
		prototype: Grip; // ObjectGrip | { type: 'null' }
		ownProperties: PropertyDescriptors;
		safeGetterValues?: SafeGetterValueDescriptors;
	}
	
	interface CompletionValue {
		return?: Grip;
		throw?: Grip;
		terminated?: boolean;
	}
	
	interface Frame {
		type: string; // 'global' | 'call' | 'eval' | 'clientEvaluate'
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
		line?: number;
		column?: number;
	}

	interface UrlSourceLocation extends SourceLocation {
		source: Source;
	}
	
	interface EvalSourceLocation extends SourceLocation {
		eval: SourceLocation;
		id: number;
	}
	
	interface FunctionConstructorSourceLocation extends SourceLocation {
		function: SourceLocation;
		id: number;
	}
	
	interface Source {
		actor: string;
		url: string;
		isBlackBoxed: boolean;
	}
	
	interface Environment {
		type: string; // 'object' | 'function' | 'with' | 'block'
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
		type: string;  // 'null' | 'undefined' | 'Infinity' | '-Infinity' | 'NaN' | '-0' | 'longString' | 'object'
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
