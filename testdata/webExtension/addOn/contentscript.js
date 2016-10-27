setTimeout(() => { 
	chrome.runtime.sendMessage({ "foo": "bar" });
}, 200);
