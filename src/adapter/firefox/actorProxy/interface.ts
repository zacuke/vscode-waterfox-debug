/**
 * An ActorProxy is a client-side reference to an actor on the server side of the 
 * Mozilla Debugging Protocol as defined in
 * https://github.com/mozilla/gecko-dev/blob/master/devtools/docs/backend/protocol.md
 */
export interface ActorProxy {
	name: string;
	receiveResponse(response: FirefoxDebugProtocol.Response): void;
}
