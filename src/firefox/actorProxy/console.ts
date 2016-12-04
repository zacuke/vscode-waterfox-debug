import { Log } from '../../util/log';
import { EventEmitter } from 'events';
import { DebugConnection } from '../connection';
import { PendingRequests, PendingRequest } from './pendingRequests';
import { ActorProxy } from './interface';

let log = Log.create('ConsoleActorProxy');

export class ConsoleActorProxy extends EventEmitter implements ActorProxy {

	private static listenFor = ['PageError', 'ConsoleAPI'];

	private pendingStartListenersRequests = new PendingRequests<void>();
	private pendingStopListenersRequests = new PendingRequests<void>();
	private pendingResultIDRequests = new PendingRequests<number>();
	private pendingEvaluateRequests = new Map<number, PendingRequest<FirefoxDebugProtocol.Grip>>();

	constructor(private _name: string, private connection: DebugConnection) {
		super();
		this.connection.register(this);
	}

	public get name() {
		return this._name;
	}

	public startListeners(): Promise<void> {
		log.debug('Starting console listeners');

		return new Promise<void>((resolve, reject) => {
			this.pendingStartListenersRequests.enqueue({ resolve, reject });
			this.connection.sendRequest({
				to: this.name, type: 'startListeners',
				listeners: ConsoleActorProxy.listenFor
			});
		});
	}

	public stopListeners(): Promise<void> {
		log.debug('Stopping console listeners');

		return new Promise<void>((resolve, reject) => {
			this.pendingStopListenersRequests.enqueue({ resolve, reject });
			this.connection.sendRequest({
				to: this.name, type: 'stopListeners',
				listeners: ConsoleActorProxy.listenFor
			});
		});
	}

	/**
	 * Evaluate the given expression. This will create 2 PendingRequest objects because we expect
	 * 2 answers: the first answer gives us a resultID for the evaluation result. The second answer
	 * gives us the actual evaluation result.
	 */
	public evaluate(expr: string, frameActorName?: string): Promise<FirefoxDebugProtocol.Grip> {
		log.debug(`Evaluating '${expr}' on console ${this.name}`);

		return new Promise<FirefoxDebugProtocol.Grip>((resolveEvaluate, rejectEvaluate) => {

			// we don't use a promise for the pendingResultIDRequest because we need the
			// pendingEvaluateRequest to be enqueued *immediately* after receiving the resultID
			// message (and a promise doesn't call its callbacks immediately after being resolved,
			// but rather schedules them to be called later)
			this.pendingResultIDRequests.enqueue({
				resolve: (resultID) => {
					this.pendingEvaluateRequests.set(resultID, { 
						resolve: resolveEvaluate, reject: rejectEvaluate
					});
				},
				reject: () => {}
			});

			let escapedExpression = expr.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
			let tryExpression = `eval("try{${escapedExpression}}catch(e){e.name+':'+e.message}")`;
			this.connection.sendRequest({
				to: this.name, type: 'evaluateJSAsync',
				text: tryExpression, frameActor: frameActorName
			});
		})
	}

	public receiveResponse(response: FirefoxDebugProtocol.Response): void {

		if (response['startedListeners']) {

			log.debug('Listeners started');
			this.pendingStartListenersRequests.resolveOne(undefined);

		} else if (response['stoppedListeners']) {

			log.debug('Listeners stopped');
			this.pendingStartListenersRequests.resolveOne(undefined);

		} else if (response['type'] === 'consoleAPICall') {

			log.debug(`Received ConsoleAPI message`);
			this.emit('consoleAPI', (<FirefoxDebugProtocol.ConsoleAPICallResponse>response).message);

		} else if (response['type'] === 'pageError') {

			log.debug(`Received PageError message`);
			this.emit('pageError', (<FirefoxDebugProtocol.PageErrorResponse>response).pageError);

		} else if (response['type'] === 'evaluationResult') {

			log.debug(`Received EvaluationResult message`);
			let resultResponse = <FirefoxDebugProtocol.EvaluationResultResponse>response;
			if (!this.pendingEvaluateRequests.has(resultResponse.resultID)) {
				log.error('Received evaluationResult with unknown resultID');
			} else {
				this.pendingEvaluateRequests.get(resultResponse.resultID)!.resolve(resultResponse.result);
			}

		} else if (response['resultID']) {

			log.debug(`Received ResultID message`);
			this.pendingResultIDRequests.resolveOne(response['resultID']);

		} else {

			log.warn("Unknown message from ConsoleActor: " + JSON.stringify(response));

		}
	}

	public onConsoleAPICall(cb: (body: FirefoxDebugProtocol.ConsoleAPICallResponseBody) => void) {
		this.on('consoleAPI', cb);
	}

	public onPageErrorCall(cb: (body: FirefoxDebugProtocol.PageErrorResponseBody) => void) {
		this.on('pageError', cb);
	}
}
