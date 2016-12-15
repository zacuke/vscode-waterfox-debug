function noop() {

	let dummy;

}

function vars(arg) {
	let bool1 = false;
	let bool2 = true;
	let num1 = 0;
	let num2 = factorial(5);
	let str1 = '';
	{
		let str2 = 'foo';
		let undef = undefined;
		let nul = null;
		let sym1 = Symbol('Local Symbol');
		let sym2 = Symbol.for('Global Symbol');
		noop();
	}
}

function factorial(n) {
	if (n <= 1) {
		return 1;
	} else {
		return n * factorial(n - 1);
	}
}

function loadScript(url) {
	var head= document.getElementsByTagName('head')[0];
	var script= document.createElement('script');
	script.type= 'text/javascript';
	script.src= url;
	head.appendChild(script);
}

function throwUncaughtException() {
	throw new Error('TestException');
}

function throwAndCatchException() {
	try {
		throw new Error('TestException');
	} catch(e) {}
}

var worker;

function startWorker() {
	worker = new Worker('worker.js');
	worker.onmessage = function(e) {
		let received = e.data;
		noop();
	}
}

function callWorker() {
	worker.postMessage({ foo: 'bar' });
}

var obj = {
	x: 17,
	y: {
		z: 'xyz'
	}
}

function doEval(expr) {
	return eval(expr);
}
