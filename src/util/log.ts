export enum LogLevel { Debug, Info, Warn, Error }

export class Log {
	
	private static logLevel: LogLevel = LogLevel.Debug;
	
	public static log(msg: string, level: LogLevel) {
		if (level >= this.logLevel) {
			console.log(msg);
		}
	}

	public static debug(msg: string): void {
		this.log(msg, LogLevel.Debug);
	}
	
	public static info(msg: string): void {
		this.log(msg, LogLevel.Info);
	}
	
	public static warn(msg: string): void {
		this.log(msg, LogLevel.Warn);
	}
	
	public static error(msg: string): void {
		this.log(msg, LogLevel.Error);
	}
}