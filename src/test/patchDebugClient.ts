import { DebugProtocol } from 'vscode-debugprotocol';
import { DebugClient } from 'vscode-debugadapter-testsupport/lib/debugClient';

declare module 'vscode-debugadapter-testsupport/lib/debugClient' {
	interface DebugClient {
		customRequest(command: string, args?: any): Promise<DebugProtocol.Response>;
	}
}
DebugClient.prototype.customRequest = function(command: string, args?: any) {
	return this.send(command, args);
}
