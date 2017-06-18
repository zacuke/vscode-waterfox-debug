let messageBox = document.getElementById('messageBox');
setInterval(() => {
	let message = messageBox.textContent;
	if (message.length > 0) {
		messageBox.textContent = '';
		chrome.runtime.sendMessage({ "foo": message });
	}
}, 200);
