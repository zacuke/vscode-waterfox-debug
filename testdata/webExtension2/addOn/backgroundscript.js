chrome.runtime.onMessage.addListener((msg) => {
	console.log('foo: ' + msg.foo);
});
