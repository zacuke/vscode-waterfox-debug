/**
 * An ActorProxy is a client-side reference to an actor on the server side of the 
 * Mozilla Debugging Protocol as defined in https://wiki.mozilla.org/Remote_Debugging_Protocol
 */
export interface ActorProxy {
	name: string;
	receiveResponse(response: FirefoxDebugProtocol.Response): void;
}
