declare module "zip-dir" {
	function zipWrite(path: string, options: any, cb: (err: any, buffer: Buffer) => void): string;
	namespace zipWrite{}
	export = zipWrite;
}
