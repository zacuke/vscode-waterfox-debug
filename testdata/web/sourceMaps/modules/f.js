import { g } from './g';

// Test
function f() {
	var x = 1;
	x = 2;
	x = g(x);
	x = g(x);
}

window.f = f;
