setTimeout(() => { 
	self.port.emit("test", { "foo": "bar" });
}, 500);
