import { Log } from '../../util/log';
import { DebugConnection, ActorProxy } from '../index';
import { PendingRequests } from './pendingRequests';

let log = Log.create('PreferenceActorProxy');

export class PreferenceActorProxy implements ActorProxy {

	private pendingGetPrefRequests = new PendingRequests<string>();

	constructor(public readonly name: string, private connection: DebugConnection) {
		this.connection.register(this);
	}

	public async getBoolPref(pref: string): Promise<boolean> {

		let prefString = await this.getPref(pref, 'Bool');
		return (prefString === 'true');

	}

	public getCharPref(pref: string): Promise<string> {

		return this.getPref(pref, 'Char');

	}

	public async getIntPref(pref: string): Promise<number> {

		let prefString = await this.getPref(pref, 'Bool');
		return parseInt(prefString, 10);

	}

	private getPref(pref: string, type: 'Bool' | 'Char' | 'Int'): Promise<string> {

		log.debug(`Getting preference value for ${pref}`);

		return new Promise<string>((resolve, reject) => {
			this.pendingGetPrefRequests.enqueue({ resolve, reject });
			this.connection.sendRequest({ 
				to: this.name,
				type: `get${type}Pref`,
				value: pref
			});
		});
	}

	receiveResponse(response: any): void {

		if (response['value']) {

			this.pendingGetPrefRequests.resolveOne(response['value']);

		} else if (response['error']) {

			log.warn("Error from PreferenceActor: " + JSON.stringify(response));
			this.pendingGetPrefRequests.rejectOne(response['message'] || response['error']);

		} else {

			log.warn("Unknown message from PreferenceActor: " + JSON.stringify(response));

		}
	}
}