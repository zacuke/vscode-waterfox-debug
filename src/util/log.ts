import * as fs from 'fs';

export enum LogLevel { Debug, Info, Warn, Error }

export interface LogConfiguration {
	fileName?: string;
	fileLevel?: { [logName: string]: LogLevel };
	consoleLevel?: { [logName: string]: LogLevel };
}

export class Log {

	private static startTime = Date.now();
	
	private static _config: LogConfiguration;
	
	private static logs = new Map<string, Log>();
	private static fileDescriptor: number;

	public static set config(newConfig: LogConfiguration) {
		if (Log.fileDescriptor !== undefined) {
			fs.closeSync(Log.fileDescriptor);
			Log.fileDescriptor = undefined;
		}

		Log._config = newConfig;
		if (Log._config.fileName) {
			try {
				Log.fileDescriptor = fs.openSync(Log._config.fileName, 'w');
			} catch(e) {}
		}

		Log.logs.forEach((log) => log.configure());
	}
	
	public static consoleLog: (msg: string) => void = console.log;
	
	public static create(name: string): Log {
		return new Log(name);
	}

	private fileLevel: LogLevel;
	private consoleLevel: LogLevel;
	private minLevel: LogLevel;
	
	constructor(private name: string) {
		this.configure();
	}

	private configure() {
		this.fileLevel = undefined;
		if (Log._config.fileName && Log._config.fileLevel) {
			this.fileLevel = Log._config.fileLevel[this.name];
			if (this.fileLevel === undefined) {
				this.fileLevel = Log._config.fileLevel['default'];
			}
			if (this.fileLevel === undefined) {
				this.fileLevel = LogLevel.Info;
			}
		}
		if (Log._config.consoleLevel) {
			this.consoleLevel = Log._config.consoleLevel[this.name];
			if (this.consoleLevel === undefined) {
				this.consoleLevel = Log._config.consoleLevel['default'];
			}
		}

		this.minLevel = this.fileLevel;
		if (this.consoleLevel && !(this.consoleLevel >= this.minLevel)) {
			this.minLevel = this.consoleLevel;
		}
	}
	
	private log(msg: string, level: LogLevel, displayLevel: string) {
		if (level >= this.minLevel) {
			
			let elapsedTime = (Date.now() - Log.startTime) / 1000;
			let elapsedTimeString = elapsedTime.toFixed(3);
			while (elapsedTimeString.length < 7) {
				elapsedTimeString = '0' + elapsedTimeString;
			}
			let logMsg = displayLevel + '|' + elapsedTimeString + '|' + this.name + ': ' + msg;
			
			if ((Log.fileDescriptor !== undefined) && (level >= this.fileLevel)) {
				fs.write(Log.fileDescriptor, logMsg + '\n');
			}
			if (level >= this.consoleLevel) {
				Log.consoleLog(logMsg);
			}
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

Log.config = {
//	fileName: '/tmp/vscode-firefox-debug.log',
//	fileLevel: {
//		'default': LogLevel.Debug
//	},
//	consoleLevel: {
//		'default': LogLevel.Info,
//		'DebugConnection': LogLevel.Debug,
//	}
};
