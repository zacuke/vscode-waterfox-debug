import { DebugProtocol } from 'vscode-debugprotocol';
import { DebugClient } from 'vscode-debugadapter-testsupport/lib/debugClient';

declare module 'vscode-debugadapter-testsupport/lib/debugClient' {
	interface DebugClient {
		setVariableRequest(args: DebugProtocol.SetVariableArguments): Promise<DebugProtocol.SetVariableResponse>;
		customRequest(command: string, args?: any): Promise<DebugProtocol.Response>;
	}
}
DebugClient.prototype.setVariableRequest = function(args: DebugProtocol.SetVariableArguments): Promise<DebugProtocol.SetVariableResponse> {
	return this.send('setVariable', args).then(response => <DebugProtocol.SetVariableResponse>response);
}
DebugClient.prototype.customRequest = function(command: string, args?: any) {
	return this.send(command, args);
}
