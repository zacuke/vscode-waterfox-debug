declare function noop(): any;
try {
	throw new Error();
} catch(e) {
	noop();
}
