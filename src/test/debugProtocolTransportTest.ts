import { Log } from '../util/log';
import { EventEmitter } from 'events';
import { DebugProtocolTransport, SocketLike } from '../firefox/transport';

class MockSocket extends EventEmitter implements SocketLike {
	public receive(chunk: string) {
		this.emit('data', new Buffer(chunk))
	}
	public write(data: Buffer | string, encoding?: string) { }
}

let mockSocket = new MockSocket();
let transport = new DebugProtocolTransport(mockSocket);
transport.on('message', Log.debug);

mockSocket.receive('14:{"x":0,"y":21}');
mockSocket.receive('14:{"x":1,"y":17}');
mockSocket.receive('14:{"x":1,"y":17}7:{"x":1}');
mockSocket.receive('1');
mockSocket.receive('4:');
mockSocket.receive('{"x":2,"y":16}');
mockSocket.receive('14:{"x":');
mockSocket.receive('3,"y');
mockSocket.receive('":15}1');
mockSocket.receive('3:{"x":4,');
mockSocket.receive('"y":7}');

process.exit();