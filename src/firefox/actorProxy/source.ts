import { Log } from '../../util/log';
import { DebugConnection } from '../connection';
import { PendingRequests } from './pendingRequests';
import { ActorProxy } from './interface';
import { BreakpointActorProxy } from './breakpoint';

let log = Log.create('SourceActorProxy');

export class SourceActorProxy implements ActorProxy {

	private pendingSetBreakpointRequests = new PendingRequests<SetBreakpointResult>();
	private pendingFetchSourceRequests = new PendingRequests<FirefoxDebugProtocol.Grip>();
	private pendingBlackboxRequests = new PendingRequests<void>();
	
	constructor(private _source: FirefoxDebugProtocol.Source, private connection: DebugConnection) {
		this.connection.register(this);
	}

	public get name() {
		return this._source.actor;
	}

	public get source() {
		return this._source;
	}

	public get url() {
		return this._source.url;
	}

	public setBreakpoint(location: { line: number, column?: number }, condition?: string): Promise<SetBreakpointResult> {

		log.debug(`Setting breakpoint at line ${location.line} and column ${location.column} in ${this.url}`);

		return new Promise<SetBreakpointResult>((resolve, reject) => {
			this.pendingSetBreakpointRequests.enqueue({ resolve, reject });
			this.connection.sendRequest({ to: this.name, type: 'setBreakpoint', location, condition });
		});
	}

	public fetchSource(): Promise<FirefoxDebugProtocol.Grip> {

		log.debug(`Fetching source of ${this.url}`);

		return new Promise<FirefoxDebugProtocol.Grip>((resolve, reject) => {
			this.pendingFetchSourceRequests.enqueue({ resolve, reject });
			this.connection.sendRequest({ to: this.name, type: 'source' });
		});
	}

	public setBlackbox(blackbox: boolean) {

		log.debug(`Setting blackboxing of ${this.url} to ${blackbox}`);

		return new Promise<void>((resolve, reject) => {
			let type = blackbox ? 'blackbox' : 'unblackbox';
			this.pendingBlackboxRequests.enqueue({ resolve, reject });
			this.connection.sendRequest({ to: this.name, type });
		});
	}

	public dispose(): void {
		this.connection.unregister(this);
	}

	public receiveResponse(response: FirefoxDebugProtocol.Response): void {
		
		if (response['isPending'] !== undefined) {

			let setBreakpointResponse = <FirefoxDebugProtocol.SetBreakpointResponse>response;
			let actualLocation = setBreakpointResponse.actualLocation;

			log.debug(`Breakpoint has been set at ${JSON.stringify(actualLocation)} in ${this.url}`);

			let breakpointActor = this.connection.getOrCreate(setBreakpointResponse.actor,
				() => new BreakpointActorProxy(setBreakpointResponse.actor, this.connection));
			this.pendingSetBreakpointRequests.resolveOne(new SetBreakpointResult(breakpointActor, actualLocation));

		} else if (response['source'] !== undefined) {

			log.debug('Received fetchSource response');
			let grip = <FirefoxDebugProtocol.Grip>response['source'];
			this.pendingFetchSourceRequests.resolveOne(grip);

		} else if (response['error'] === 'noSuchActor') {

			log.error(`No such actor ${JSON.stringify(this.name)}`);
			this.pendingFetchSourceRequests.rejectAll('No such actor');
			this.pendingSetBreakpointRequests.rejectAll('No such actor');

		} else if (Object.keys(response).length === 1) {

			let propertyCount = Object.keys(response).length;
			if ((propertyCount === 1) || ((propertyCount === 2) && (response['pausedInSource'] !== undefined))) {

				log.debug('Received (un)blackbox response');
				this.pendingBlackboxRequests.resolveOne(undefined);

			} else {

				log.warn("Unknown message from SourceActor: " + JSON.stringify(response));

			}

		}
	}
}

export class SetBreakpointResult {
	constructor(
		public breakpointActor: BreakpointActorProxy,
		public actualLocation?: FirefoxDebugProtocol.SourceLocation
	) {}
}
