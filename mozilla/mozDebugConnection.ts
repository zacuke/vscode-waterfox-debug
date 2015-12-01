import { EventEmitter } from 'events';
import { Socket } from 'net';
import { ActorProxy, RootActorProxy } from './actorProxy';

/**
 * Connects to a target supporting the Mozilla Debugging Protocol and sends and receives messages
 */
export class MozDebugConnection {

	private transport: MozDebugProtocolTransport;
	private actors: Map<string, ActorProxy>;
	private _rootActor: RootActorProxy;

	constructor() {
		this.actors = new Map<string, ActorProxy>();
		this._rootActor = new RootActorProxy(this);
		let socket = new Socket();
		this.transport = new MozDebugProtocolTransport(socket);
		this.transport.on('message', (response: MozDebugProtocol.Response) => {
			console.log('Received ' + JSON.stringify(response));
			if (this.actors.has(response.from)) {
				this.actors.get(response.from).receiveResponse(response);
			} else {
				// TODO
			}
		});
		socket.connect(6000);
	}

	public get rootActor() {
		return this._rootActor;
	}

	public sendRequest(request: MozDebugProtocol.Request) {
		this.transport.sendMessage(request);
	}

	public register(actor: ActorProxy): void {
		this.actors.set(actor.name, actor);
	}

	public unregister(actor: ActorProxy): void {
		this.actors.delete(actor.name);
	}
}

/**
 * Implements the Remote Debugging Protocol Stream Transport
 * as defined in https://wiki.mozilla.org/Remote_Debugging_Protocol_Stream_Transport
 * Currently bulk data packets are unsupported and error handling is nonexistent
 */
export class MozDebugProtocolTransport extends EventEmitter {

	private static initialBufferLength = 11; // must be large enough to receive a complete header
	private buffer: Buffer;
	private bufferedLength: number;
	private receivingHeader: boolean;

	constructor(private socket: SocketLike) {
		super();

		this.buffer = new Buffer(MozDebugProtocolTransport.initialBufferLength);
		this.bufferedLength = 0;
		this.receivingHeader = true;

		this.socket.on('data', (chunk: Buffer) => {

			let processedLength = 0;
			while (processedLength < chunk.length) {
				// copy the maximum number of bytes possible into this.buffer
				let copyLength = Math.min(chunk.length - processedLength, this.buffer.length - this.bufferedLength);
				chunk.copy(this.buffer, this.bufferedLength, processedLength, processedLength + copyLength);
				processedLength += copyLength;
				this.bufferedLength += copyLength;

				if (this.receivingHeader) {
					// did we receive a complete header yet?
					for (var i = 0; i < this.bufferedLength; i++) {
						if (this.buffer[i] == 58) {
							// header is complete: parse it
							let bodyLength = +this.buffer.toString('ascii', 0, i);
							// create a buffer for the message body
							let bodyBuffer = new Buffer(bodyLength);
							// copy the start of the body from this.buffer
							this.buffer.copy(bodyBuffer, 0, i + 1);
							// replace this.buffer with bodyBuffer
							this.buffer = bodyBuffer;
							this.bufferedLength = this.bufferedLength - (i + 1);
							this.receivingHeader = false;
							break;
						}
					}
				} else {
					// did we receive the complete body yet?
					if (this.bufferedLength == this.buffer.length) {
						// body is complete: parse and emit it
						let msgString = this.buffer.toString('utf8');
						this.emit('message', JSON.parse(msgString));
						// get ready to receive the next header
						this.buffer = new Buffer(MozDebugProtocolTransport.initialBufferLength);
						this.bufferedLength = 0;
						this.receivingHeader = true;
					}
				}
			}
		});
	}

	public sendMessage(msg: any): void {
		let msgBuf = new Buffer(JSON.stringify(msg), 'utf8');
		this.socket.write(msgBuf.length + ':', 'ascii');
		this.socket.write(msgBuf);
	}
}

export interface SocketLike {
	on(event: string, listener: Function);
	write(buffer: Buffer);
	write(str: string, encoding: string);
}
