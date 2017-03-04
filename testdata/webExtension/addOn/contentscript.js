setTimeout(() => { 
	chrome.runtime.sendMessage({ "foo": "bar" });
}, 500);
