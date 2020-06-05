function noop() {

	let dummy = 0;

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
		let sym1 = Symbol('Local Symbol'); let sym2 = Symbol.for('Global Symbol'); let sym3 = Symbol.iterator;
		if (arg) { arg[sym1] = 'Symbol-keyed 1'; arg[sym3] = 'Symbol-keyed 2'; }
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
	var head = document.getElementsByTagName('head')[0];
	var script = document.createElement('script');
	script.type = 'text/javascript';
	script.src = url;
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

function testSkipFiles() {
	dummyFunc();
	throwError();
}

function log(...x) {
	console.log(...x);
}

function getterAndSetter() {
	let y = {
		_z: 'foo',
		get z() { return this._z; }
	};
	let x = {
		gp: 17,
		gsp: 23,
		_y: y,
		get getterProperty() { return this.gp; },
		set setterProperty(val) {},
		get getterAndSetterProperty() { return this.gsp; },
		set getterAndSetterProperty(val) {},
		get nested() { return this._y; }
	};
	return x;
}

class ProtoGetterBase {
	constructor() {
		this._z = 'bar';
	}
	get z() { return this._z; }
}
class ProtoGetter extends ProtoGetterBase {
	constructor() {
		super();
		this._y = 'foo';
	}
	get y() { return this._y; }
}
function protoGetter() {
	var x = new ProtoGetter();
	return x;
}

function inc(o) {
	console.log(`Old: ${o.x}`);
	o.x++;
	console.log(`New: ${o.x}`);
}
