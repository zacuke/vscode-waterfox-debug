import { ThreadActorProxy } from '../firefox/index';
import { FirefoxDebugSession } from '../firefoxDebugSession';
import { StoppedEvent } from 'vscode-debugadapter';

/**
 * This adapter manages the object references that are passed to VSCode in stackframes or
 * evaluateRequest results.
 * Most importantly it handles a conceptual difference between the VSCode and Firefox debug
 * protocols: VSCode expects all object references (i.e. the variablesReference property of
 * EvaluateResponse, Scope and Variable objects) to remain live even if an evaluateRequest was
 * run in the meantime, whereas Firefox by default restricts the lifetime of object references
 * to the lifetime of the current pause, so whenever an evaluateRequest is run, all stackframes
 * and evaluateRequest results that were previously passed to VSCode become stale and can't be
 * inspected anymore.
 * To bridge the difference between the protocols, this adapter implements the following strategy:
 * it remembers the watches that were previously requested by VSCode and whenever VSCode
 * requests a stackframe, it first evaluates these watches in one compound request, caches their
 * values and then fetches the stackframe which it passes to VSCode. Then, VSCode requests to
 * evaluate the watch expressions - these requests will be answered from the previously cached
 * watch values.
 */
export class ObjectReferencesAdapter {
	
	private threadId: number;
	private thread: ThreadActorProxy;
	private debugSession: FirefoxDebugSession;

	// the cached watches
	private watches: Watch[] = [];

	// the name of the FrameActor of the current top stackframe
	private currentTopFrame: string;

	// the promise for the currently running stackframe request or null if there is no
	// stackframe request currently running
	private stackFramePromise: Promise<FirefoxDebugProtocol.Frame[]> = null;
	
	constructor(threadId: number, thread: ThreadActorProxy, debugSession: FirefoxDebugSession) {
		this.threadId = threadId;
		this.thread = thread;
		this.debugSession = debugSession;
	}
	
	/**
	 * called by VSCode through FirefoxDebugSession at the start of each user-visible pause
	 */
	public fetchStackFrames(): Promise<FirefoxDebugProtocol.Frame[]> {

		if (this.stackFramePromise === null) {
			
			this.stackFramePromise = this.thread.fetchStackFrames();

			if (this.watches.length > 0) {
				
				this.stackFramePromise = this.stackFramePromise
				.then((frames) => this.thread.evaluate(this.createWatchesExpression(), frames[0].actor))
				.then((watchesGrip) => {
					this.cacheValues(watchesGrip);
					return this.thread.fetchStackFrames();
				});
			}

			this.stackFramePromise.then((frames) => {
				this.currentTopFrame = frames[0].actor;
				this.stackFramePromise = null;
			});
		}
		
		return this.stackFramePromise;
	}
	
	/**
	 * called by VSCode through FirefoxDebugSession to evaluate an expression, which is either
	 * a watch or an expression entered in the debug console
	 */	
	public evaluateRequest(expression: string, isWatch: boolean): Promise<FirefoxDebugProtocol.Grip> {
		
		if (isWatch) {

			let watch = this.findWatchFor(expression);

			if (watch !== null) {

				watch.requestedByDebugger = true;
				return Promise.resolve(watch.value);

			} else {

				// this is a new watch - we add it to the cache and force VSCode to refresh 
				this.watches.push({ expression, value: undefined, requestedByDebugger: true });
				
				if (this.stackFramePromise === null) {
					this.debugSession.sendEvent(new StoppedEvent('eval', this.threadId)); //TODO provide the proper reason...
				}
				
				return Promise.resolve(undefined);

			}
			
		} else {

			// evaluate the non-watch expression and extend the lifetime of the object reference
			// if the result is an object
			let promise = this.thread.evaluate(expression, this.currentTopFrame)
			.then((grip) => {
				if ((typeof grip === 'object') && (grip.type === 'object')) {
					return grip; //TODO extend lifetime
				} else {
					return grip;
				}
			});
			
			// force VSCode to refresh
			promise.then(() => this.debugSession.sendEvent(new StoppedEvent('eval', this.threadId))); //TODO provide the proper reason...
			
			return promise;
		}
	}

	private findWatchFor(expression: string): Watch {

		for (var i = 0; i < this.watches.length; i++) {
			let watch = this.watches[i];
			if (watch.expression === expression) {
				return watch;
			}
		}
		
		return null;
	}

	/**
	 * Create the javascript expression that evaluates all watches
	 */	
	private createWatchesExpression(): string {
		
		// remove watches that VSCode doesn't seem to be interested in anymore
		this.watches = this.watches.filter((watch) => (watch.requestedByDebugger === true));
		
		// set the requestedByDebugger flag of all watches to false
		this.watches.forEach((watch) => watch.requestedByDebugger = false);
		
		let evaluateWatchExpressions = this.watches.map((watch) => {
			
			let escapedExpression = watch.expression.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
			return `eval("try{${escapedExpression}}catch(e){e.name+':'+e.message}")`

		});
			
		return `[${evaluateWatchExpressions.join(',')}]`;
	}
	
	/**
	 * cache the values received by evaluating the expression returned by 
	 * createWatchesExpression()
	 */
	private cacheValues(watchesGrip: FirefoxDebugProtocol.Grip) {
		
		let values = (<FirefoxDebugProtocol.ObjectGrip>watchesGrip).preview.items;
		if (values.length === this.watches.length) {
			
			for (var i = 0; i < values.length; i++) {
				this.watches[i].value = values[i];
			}
			
		} else {
			// the list of watches has changed, so we need to force VSCode to refresh
			this.watches.forEach((watch) => watch.requestedByDebugger = true);
			this.debugSession.sendEvent(new StoppedEvent('eval', this.threadId)); //TODO provide the proper reason...
		}
	}
}

/**
 * Represents a watch expression and its current value
 */
class Watch {
	
	public expression: string;
	
	public value: FirefoxDebugProtocol.Grip;
	
	/**
	 * requestedByDebugger is set to false when the value is refreshed and to true when it is
	 * requested by VSCode. If the flag is still false when the watch values are refreshed the
	 * next time, the adapter assumes that VSCode is not interested in this watch anymore and 
	 * it will be removed.   
	 */
	public requestedByDebugger: boolean;
}