import { DebugSession, InitializedEvent, TerminatedEvent, StoppedEvent, OutputEvent, ThreadEvent, Thread, StackFrame, Scope, Variable, Source } from 'vscode-debugadapter';
import { DebugProtocol } from 'vscode-debugprotocol';
import { ActorProxy, TabActorProxy, ThreadActorProxy, SourceActorProxy, BreakpointActorProxy, ObjectGripActorProxy } from './mozilla/actorProxy';
import { MozDebugConnection } from './mozilla/mozDebugConnection';

class FirefoxDebugSession extends DebugSession {

	private mozDebugConnection: MozDebugConnection;

	private nextThreadId = 1;
	private threadsById = new Map<number, ThreadAdapter>();
	private threadsByActorName = new Map<string, ThreadAdapter>();
	private breakpointsBySourceUrl = new Map<string, DebugProtocol.SetBreakpointsArguments>();

	private nextFrameId = 1;
	private framesById = new Map<number, FrameAdapter>();

	private nextVariablesProviderId = 1;
	private variablesProvidersById = new Map<number, VariablesProvider>();

	public constructor(debuggerLinesStartAt1: boolean, isServer: boolean = false) {
		super(debuggerLinesStartAt1, isServer);
	}

	public registerVariablesProvider(variablesProvider: VariablesProvider) {
		let providerId = this.nextVariablesProviderId++;
		variablesProvider.variablesProviderId = providerId;
		this.variablesProvidersById.set(providerId, variablesProvider);
	}

	public createObjectGripActorProxy(objectGrip: MozDebugProtocol.ObjectGrip): ObjectGripActorProxy {
		return new ObjectGripActorProxy(objectGrip, this.mozDebugConnection);
	}
	
	protected initializeRequest(response: DebugProtocol.InitializeResponse, args: DebugProtocol.InitializeRequestArguments): void {
		this.sendResponse(response);

		// connect to Firefox
		this.mozDebugConnection = new MozDebugConnection();

		// attach to all tabs, register the corresponding threads
		// and inform VSCode about them
		this.mozDebugConnection.rootActor.onTabOpened((tabActor) => {
			tabActor.attach().then((threadActor) => {

				let threadId = this.nextThreadId++;
				let threadAdapter = new ThreadAdapter(threadId, threadActor);
				this.threadsById.set(threadId, threadAdapter);
				this.threadsByActorName.set(threadActor.name, threadAdapter);

				threadActor.onNewSource((sourceActor) => {
					let sourceAdapter = new SourceAdapter(sourceActor);
					threadAdapter.sources.push(sourceAdapter);
					if (this.breakpointsBySourceUrl.has(sourceActor.url)) {
						let breakpoints = this.breakpointsBySourceUrl.get(sourceActor.url).lines;
						this.setBreakpointsOnSourceActor(breakpoints, sourceAdapter, threadActor);
					}
				});
				
				threadActor.onPaused((why) => {
					this.sendEvent(new StoppedEvent(why, threadId));
				});
				
				threadActor.onExited(() => {
					this.threadsById.delete(threadId);
					this.threadsByActorName.delete(threadActor.name);
					this.sendEvent(new ThreadEvent('exited', threadId));
				});
				
				threadActor.fetchSources();

				this.sendEvent(new ThreadEvent('started', threadId));
			});
		});

		this.mozDebugConnection.rootActor.fetchTabs();
		
		// now we are ready to accept breakpoints -> fire the initialized event to give UI a chance to set breakpoints
		this.sendEvent(new InitializedEvent());
	}

	protected threadsRequest(response: DebugProtocol.ThreadsResponse): void {

		let responseThreads: Thread[] = [];
		this.threadsById.forEach((threadAdapter) => {
			responseThreads.push(new Thread(threadAdapter.id, threadAdapter.actor.name));
		});
		response.body = { threads: responseThreads };
		
		this.sendResponse(response);
	}
	
    protected setBreakPointsRequest(response: DebugProtocol.SetBreakpointsResponse, args: DebugProtocol.SetBreakpointsArguments): void {

		let firefoxSourceUrl = this.convertDebuggerPathToClient(args.source.path);
		this.breakpointsBySourceUrl.set(firefoxSourceUrl, args);

		let responseScheduled = false;		
		this.threadsById.forEach((threadAdapter) => {
			
			let sourceAdapter: SourceAdapter = null;
			for (let i = 0; i < threadAdapter.sources.length; i++) {
				if (threadAdapter.sources[i].actor.url === firefoxSourceUrl) {
					sourceAdapter = threadAdapter.sources[i];
					break;
				}
			}

			if (sourceAdapter !== null) {
				let setBreakpointsPromise = this.setBreakpointsOnSourceActor(args.lines, sourceAdapter, threadAdapter.actor);
				if (!responseScheduled) {
					setBreakpointsPromise.then((breakpointAdapters) => {

						response.body.breakpoints = breakpointAdapters.map((breakpointAdapter) => 
							<DebugProtocol.Breakpoint>{ verified: true, line: breakpointAdapter.actualLine });

						this.sendResponse(response);
						
					});
					responseScheduled = true;
				}
			}
		});
	}
	
	private setBreakpointsOnSourceActor(breakpointsToSet: number[], sourceAdapter: SourceAdapter, threadActor: ThreadActorProxy): Promise<BreakpointAdapter[]> {
		return threadActor.runOnPausedThread((resume) => 
			this.setBreakpointsOnPausedSourceActor(breakpointsToSet, sourceAdapter, resume));
	}

	private setBreakpointsOnPausedSourceActor(breakpointsToSet: number[], sourceAdapter: SourceAdapter, resume: () => void): Promise<BreakpointAdapter[]> {
		
		let result = new Promise<BreakpointAdapter[]>((resolve) => {
			sourceAdapter.currentBreakpoints.then((oldBreakpoints) => {
				
				let newBreakpoints: BreakpointAdapter[] = [];
				let breakpointsBeingRemoved: Promise<void>[] = [];
				let breakpointsBeingSet: Promise<void>[] = [];
				
				oldBreakpoints.forEach((breakpointAdapter) => {
					let breakpointIndex = breakpointsToSet.indexOf(breakpointAdapter.requestedLine);
					if (breakpointIndex >= 0) {
						newBreakpoints[breakpointIndex] = breakpointAdapter;
						breakpointsToSet[breakpointIndex] = undefined;
					} else {
						breakpointsBeingRemoved.push(breakpointAdapter.actor.delete());
					}
				});

				breakpointsToSet.map((requestedLine, index) => {
					if (requestedLine !== undefined) {
						breakpointsBeingSet.push(sourceAdapter.actor.setBreakpoint({ line: requestedLine })
						.then((setBreakpointResult) => {
							newBreakpoints[index] = new BreakpointAdapter(
								requestedLine, setBreakpointResult.actualLocation.line, setBreakpointResult.breakpointActor); 
						}));
					}
				});
				
				Promise.all(breakpointsBeingRemoved).then(() => Promise.all(breakpointsBeingSet)).then(() => {
					resolve(newBreakpoints);
					resume();
				});
			});
		});
		
		sourceAdapter.currentBreakpoints = result;
		return result;
	}

	protected pauseRequest(response: DebugProtocol.PauseResponse, args: DebugProtocol.PauseArguments): void {
		this.threadsById.get(args.threadId).actor.interrupt();
		this.sendResponse(response);
	}
	
	protected continueRequest(response: DebugProtocol.ContinueResponse, args: DebugProtocol.ContinueArguments): void {
		this.terminatePause();
		this.threadsById.get(args.threadId).actor.resume();
		this.sendResponse(response);
	}

	protected nextRequest(response: DebugProtocol.NextResponse, args: DebugProtocol.NextArguments): void {
		this.terminatePause();
		this.threadsById.get(args.threadId).actor.stepOver();
		this.sendResponse(response);
	}

	protected stepInRequest(response: DebugProtocol.StepInResponse, args: DebugProtocol.StepInArguments): void {
		this.terminatePause();
		this.threadsById.get(args.threadId).actor.stepInto();
		this.sendResponse(response);
	}

	protected stepOutRequest(response: DebugProtocol.StepOutResponse, args: DebugProtocol.StepOutArguments): void {
		this.terminatePause();
		this.threadsById.get(args.threadId).actor.stepOut();
		this.sendResponse(response);
	}
	
	private terminatePause() {
		this.variablesProvidersById.clear();
		this.framesById.clear();
	}
	
	protected stackTraceRequest(response: DebugProtocol.StackTraceResponse, args: DebugProtocol.StackTraceArguments): void {

		let threadActor = this.threadsById.get(args.threadId).actor;

		threadActor.fetchStackFrames().then((frames) => {

			let frameAdapters = frames.map((frame) => {
				let frameId = this.nextFrameId++;
				let frameAdapter = new FrameAdapter(frameId, frame);
				this.framesById.set(frameId, frameAdapter);
				return frameAdapter;
			});

			response.body.stackFrames = frameAdapters.map((frameAdapter) => frameAdapter.getStackframe());
			this.sendResponse(response);
		});
	}
	
	protected scopesRequest(response: DebugProtocol.ScopesResponse, args: DebugProtocol.ScopesArguments): void {
		
		let frameAdapter = this.framesById.get(args.frameId);
		let environmentAdapter = EnvironmentAdapter.from(frameAdapter.frame.environment);
		let scopeAdapters = environmentAdapter.getScopes(this);
		
		response.body.scopes = scopeAdapters.map((scopeAdapter) => scopeAdapter.getScope());
		
		this.sendResponse(response);
	}
	
	protected variablesRequest(response: DebugProtocol.VariablesResponse, args: DebugProtocol.VariablesArguments): void {
		
		let variablesProvider = this.variablesProvidersById.get(args.variablesReference);
		
		variablesProvider.getVariables(this).then((vars) => {
			response.body.variables = vars;
			this.sendResponse(response);
		})
	}
}

class ThreadAdapter {
	public id: number;
	public actor: ThreadActorProxy;
	public sources: SourceAdapter[];
	
	public constructor(id: number, actor: ThreadActorProxy) {
		this.id = id;
		this.actor = actor;
		this.sources = [];
	}
}

class SourceAdapter {
	public actor: SourceActorProxy;
	public currentBreakpoints: Promise<BreakpointAdapter[]>;
	
	public constructor(actor: SourceActorProxy) {
		this.actor = actor;
		this.currentBreakpoints = Promise.resolve([]);
	}
}

class BreakpointAdapter {
	public requestedLine: number;
	public actualLine: number;
	public actor: BreakpointActorProxy;
	
	public constructor(requestedLine: number, actualLine: number, actor: BreakpointActorProxy) {
		this.requestedLine = requestedLine;
		this.actualLine = actualLine;
		this.actor = actor;
	}
}

class FrameAdapter {
	public id: number;
	public frame: MozDebugProtocol.Frame;
	
	public constructor(id: number, frame: MozDebugProtocol.Frame) {
		this.id = id;
		this.frame = frame;
	}
	
	public getStackframe(): StackFrame {
		let sourcePath: string = null;
		if ((<MozDebugProtocol.UrlSourceLocation>this.frame.where).url !== undefined) {
			sourcePath = (<MozDebugProtocol.UrlSourceLocation>this.frame.where).url;
		}
		let source = new Source('Some source', sourcePath);
		return new StackFrame(this.id, 'Some frame', source, this.frame.where.line, this.frame.where.column);
	}
}

abstract class EnvironmentAdapter {
	
	public environment: MozDebugProtocol.Environment;
	public parent: EnvironmentAdapter;
	
	public constructor(environment: MozDebugProtocol.Environment) {
		this.environment = environment;
		if (environment.parent !== undefined) {
			this.parent = EnvironmentAdapter.from(environment.parent);
		}
	}
	
	public static from(environment: MozDebugProtocol.Environment): EnvironmentAdapter {
		switch (environment.type) {
			case 'object':
				return new ObjectEnvironmentAdapter(<MozDebugProtocol.ObjectEnvironment>environment);
			case 'function':
				return new FunctionEnvironmentAdapter(<MozDebugProtocol.FunctionEnvironment>environment);
			case 'with':
				return new WithEnvironmentAdapter(<MozDebugProtocol.WithEnvironment>environment);
			case 'block':
				return new BlockEnvironmentAdapter(<MozDebugProtocol.BlockEnvironment>environment);
			default: 
				return null;
		}
	}
	
	public getScopes(debugSession: FirefoxDebugSession): ScopeAdapter[] {
		let scopes = this.getOwnScopes(debugSession);
		if (this.parent !== undefined) {
			scopes = scopes.concat(this.parent.getScopes(debugSession));
		}
		return scopes;
	}
	
	protected abstract getOwnScopes(debugSession: FirefoxDebugSession): ScopeAdapter[];
}

class ObjectEnvironmentAdapter extends EnvironmentAdapter {
	
	public environment: MozDebugProtocol.ObjectEnvironment;
	
	public constructor(environment: MozDebugProtocol.ObjectEnvironment) {
		super(environment);
	}
	
	protected getOwnScopes(debugSession: FirefoxDebugSession): ScopeAdapter[] {
		let objectGrip = this.environment.object;
		if ((typeof objectGrip === 'boolean') || (typeof objectGrip === 'number') || (typeof objectGrip === 'string')) {
			//TODO this shouldn't happen(?)
			return [];
		} else if (objectGrip.type !== 'object') {
			//TODO this also shouldn't happen(?)
			return [];
		} else {
			return [ new ObjectScopeAdapter('Some object scope', <MozDebugProtocol.ObjectGrip>objectGrip, debugSession) ];
		}
	}
}

class FunctionEnvironmentAdapter extends EnvironmentAdapter {

	public environment: MozDebugProtocol.FunctionEnvironment;
	
	public constructor(environment: MozDebugProtocol.FunctionEnvironment) {
		super(environment);
	}
	
	protected getOwnScopes(debugSession: FirefoxDebugSession): ScopeAdapter[] {
		return [
			new LocalVariablesScopeAdapter('Some local variables', this.environment.bindings.variables, debugSession),
			new FunctionArgumentsScopeAdapter('Some function arguments', this.environment.bindings.arguments, debugSession)
		];
	}
}

class WithEnvironmentAdapter extends EnvironmentAdapter {

	public environment: MozDebugProtocol.WithEnvironment;
	
	public constructor(environment: MozDebugProtocol.WithEnvironment) {
		super(environment);
	}
	
	protected getOwnScopes(debugSession: FirefoxDebugSession): ScopeAdapter[] {
		//TODO this is the same as in ObjectEnvironmentAdapter...
		let objectGrip = this.environment.object;
		if ((typeof objectGrip === 'boolean') || (typeof objectGrip === 'number') || (typeof objectGrip === 'string')) {
			//TODO this shouldn't happen(?)
			return [];
		} else if (objectGrip.type !== 'object') {
			//TODO this also shouldn't happen(?)
			return [];
		} else {
			return [ new ObjectScopeAdapter('Some object scope', <MozDebugProtocol.ObjectGrip>objectGrip, debugSession) ];
		}
	}
}

class BlockEnvironmentAdapter extends EnvironmentAdapter {

	public environment: MozDebugProtocol.BlockEnvironment;
	
	public constructor(environment: MozDebugProtocol.BlockEnvironment) {
		super(environment);
	}
	
	protected getOwnScopes(debugSession: FirefoxDebugSession): ScopeAdapter[] {
		return [ new LocalVariablesScopeAdapter('Some local variables', this.environment.bindings.variables, debugSession) ];
	}
}

interface VariablesProvider {
	variablesProviderId: number;
	getVariables(debugSession: FirefoxDebugSession): Promise<Variable[]>;
}

abstract class ScopeAdapter implements VariablesProvider {
	
	public name: string;
	public variablesProviderId: number;
	
	public constructor(name: string, debugSession: FirefoxDebugSession) {
		this.name = name;
		debugSession.registerVariablesProvider(this);
	}
	
	public getScope(): Scope {
		return new Scope(this.name, this.variablesProviderId);
	}
	
	public abstract getVariables(debugSession: FirefoxDebugSession): Promise<Variable[]>;
}

class ObjectScopeAdapter extends ScopeAdapter {
	
	public object: MozDebugProtocol.ObjectGrip;
	public objectGripActor: ObjectGripActorProxy;
	
	public constructor(name: string, object: MozDebugProtocol.ObjectGrip, debugSession: FirefoxDebugSession) {
		super(name, debugSession);
		this.object = object;
		this.objectGripActor = debugSession.createObjectGripActorProxy(this.object);
	}
	
	public getVariables(debugSession: FirefoxDebugSession): Promise<Variable[]> {
		
		return this.objectGripActor.fetchPrototypeAndProperties().then((prototypeAndProperties) => {

			let variables: Variable[] = [];
			for (let varname in prototypeAndProperties.ownProperties) {
				variables.push(getVariableFromPropertyDescriptor(varname, prototypeAndProperties.ownProperties[varname], debugSession));
			}
			
			return variables;
		});
	}
}

class LocalVariablesScopeAdapter extends ScopeAdapter {
	
	public name: string;
	public variables: MozDebugProtocol.PropertyDescriptors;
	
	public constructor(name: string, variables: MozDebugProtocol.PropertyDescriptors, debugSession: FirefoxDebugSession) {
		super(name, debugSession);
		this.variables = variables;
	}
	
	public getVariables(debugSession: FirefoxDebugSession): Promise<Variable[]> {
		
		let variables: Variable[] = [];
		for (let varname in this.variables) {
			variables.push(getVariableFromPropertyDescriptor(varname, this.variables[varname], debugSession));
		}
		
		return Promise.resolve(variables);
	}
}

class FunctionArgumentsScopeAdapter extends ScopeAdapter {
	
	public name: string;
	public args: MozDebugProtocol.PropertyDescriptors[];
	
	public constructor(name: string, args: MozDebugProtocol.PropertyDescriptors[], debugSession: FirefoxDebugSession) {
		super(name, debugSession);
		this.args = args;
	}
	
	public getVariables(debugSession: FirefoxDebugSession): Promise<Variable[]> {

		let variables: Variable[] = [];
		this.args.forEach((arg) => {
			for (let varname in arg) {
				variables.push(getVariableFromPropertyDescriptor(varname, arg[varname], debugSession));
			}
		});
		
		return Promise.resolve(variables);
	}
}

function getVariableFromPropertyDescriptor(varname: string, propertyDescriptor: PropertyDescriptor, debugSession: FirefoxDebugSession): Variable {
	if (propertyDescriptor.value !== undefined) {
		return getVariableFromGrip(varname, propertyDescriptor.value, debugSession);
	} else {
		return new Variable(varname, 'unknown');
	}
}

function getVariableFromGrip(varname: string, grip: MozDebugProtocol.Grip, debugSession: FirefoxDebugSession): Variable {
	if ((typeof grip === 'boolean') || (typeof grip === 'number') || (typeof grip === 'string')) {
		return new Variable(varname, <string>grip);
	} else {
		switch (grip.type) {
			case 'null':
			case 'undefined':
			case 'Infinity':
			case '-Infinity':
			case 'NaN':
			case '-0':
				return new Variable(varname, grip.type);
			case 'longString':
				return new Variable(varname, (<MozDebugProtocol.LongStringGrip>grip).initial);
			case 'object':
				let variablesProvider = new ObjectScopeAdapter(varname, grip, debugSession);
				return new Variable(varname, '...', variablesProvider.variablesProviderId);
		}
	}
}

DebugSession.run(FirefoxDebugSession);
