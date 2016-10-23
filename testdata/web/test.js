function test() {

	console.log("Test");

}

function loadScript(url) {
	var head= document.getElementsByTagName('head')[0];
	var script= document.createElement('script');
	script.type= 'text/javascript';
	script.src= url;
	head.appendChild(script);
}

function throwUncaughtException() {
	throw new Error('Test exception');
}

function throwAndCatchException() {
	try {
		throw new Error('Test exception');
	} catch(e) {}
}
