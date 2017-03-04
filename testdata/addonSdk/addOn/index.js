var pageMod = require("sdk/page-mod");

pageMod.PageMod({
	include: "file://*",
	contentScriptFile: "./contentscript.js",
	onAttach: (worker) => {
		worker.port.on("test", (msg) => {
			console.log('foo: ' + msg.foo);
		});
	}
});
