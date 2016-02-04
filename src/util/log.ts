export enum LogLevel { Debug, Info, Warn, Error }

export interface LogConfiguration {
	[logName: string]: LogLevel;
}

export class Log {

	private static startTime = Date.now();
	
	private static _config: LogConfiguration = {
		'default': LogLevel.Info
	};
	
	private static logs = new Map<string, Log>();
	
	public static set config(newConfig: LogConfiguration) {
		Log._config = newConfig;
		Log.logs.forEach((log) => log.configure());
	} 
	
	public static create(name: string): Log {
		return new Log(name);
	}

	private logLevel: LogLevel;
	
	constructor(private name: string) {
		this.configure();
	}

	private configure() {
		this.logLevel = Log._config[this.name];
		if (this.logLevel === undefined) {
			this.logLevel = Log._config['default'];
		}
		if (this.logLevel === undefined) {
			this.logLevel = LogLevel.Info;
		}
	}
	
	private log(msg: string, level: LogLevel, displayLevel: string) {
		if (level >= this.logLevel) {
			
			let elapsedTime = (Date.now() - Log.startTime) / 1000;
			let elapsedTimeString = elapsedTime.toFixed(3);
			while (elapsedTimeString.length < 7) {
				elapsedTimeString = '0' + elapsedTimeString;
			}
			
			console.log(displayLevel + '|' + elapsedTimeString + '|' + this.name + ': ' + msg);
		}
	}

	public debug(msg: string): void {
		this.log(msg, LogLevel.Debug, 'DEBUG');
	}
	
	public info(msg: string): void {
		this.log(msg, LogLevel.Info, 'INFO ');
	}
	
	public warn(msg: string): void {
		this.log(msg, LogLevel.Warn, 'WARN ');
	}
	
	public error(msg: string): void {
		this.log(msg, LogLevel.Error, 'ERROR');
	}
}