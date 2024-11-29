import { EventEmitter } from 'events';
import { DebugConnection } from '../connection';
import { ActorProxy } from './interface';
import { PendingRequests } from '../../util/pendingRequests';

export abstract class BaseActorProxy extends EventEmitter implements ActorProxy {

	private readonly pendingRequests = new PendingRequests<any>();

	constructor(
		public readonly name: string,
		private readonly responseTypes: string[],
		protected readonly connection: DebugConnection
	) {
		super();
		this.connection.register(this);
	}

	sendRequest<T extends Omit<WaterfoxDebugProtocol.Request, 'to'>, S>(request: T): Promise<S> {
		return new Promise<S>((resolve, reject) => {
			this.pendingRequests.enqueue({ resolve, reject });
			this.connection.sendRequest({ ...request, to: this.name });
		});
	}

	async getRequestTypes(): Promise<string[]> {
		return (await this.sendRequest<any, WaterfoxDebugProtocol.RequestTypesResponse>(
			{ type: 'requestTypes' })
		).requestTypes;
	}

	abstract handleEvent(event: WaterfoxDebugProtocol.Event): void;

	receiveResponse(message: WaterfoxDebugProtocol.Response): void {
		if (message.error) {
			this.pendingRequests.rejectOne(message);
		} else if (message.type && !this.responseTypes.includes(message.type)) {
			this.handleEvent(message as WaterfoxDebugProtocol.Event);
		} else {
			this.pendingRequests.resolveOne(message);
		}
	}

	dispose(): void {
		this.connection.unregister(this);
	}
}
