declare module "jpm/lib/xpi" {
	function xpi(manifest: any, options: any): Promise<string>;
	namespace xpi{}
	export = xpi;
}
