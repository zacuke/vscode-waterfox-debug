setTimeout(() => { 
	chrome.runtime.sendMessage({ "foo": "bar" });
}, 1500);
