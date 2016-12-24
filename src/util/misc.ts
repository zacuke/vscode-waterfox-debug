export function concatArrays<T>(arrays: T[][]): T[] {
	return [].concat.apply([], arrays);
}

export function urlBasename(url: string): string {
	let lastSepIndex = url.lastIndexOf('/');
	if (lastSepIndex < 0) {
		return url;
	} else {
		return url.substring(lastSepIndex + 1);
	}
}

export function delay(timeout: number): Promise<void> {
	return new Promise<void>((resolve) => {
		setTimeout(resolve, timeout);
	});
}

export function exceptionGripToString(grip: FirefoxDebugProtocol.Grip | null | undefined) {

	if ((typeof grip === 'object') && (grip !== null) && (grip.type === 'object')) {

		let preview = (<FirefoxDebugProtocol.ObjectGrip>grip).preview;
		if (preview !== undefined) {

			if (preview.name === 'ReferenceError') {
				return 'not available';
			}

			let str = (preview.name !== undefined) ? (preview.name + ': ') : '';
			str += (preview.message !== undefined) ? preview.message : '';
			if (str !== '') {
				return str;
			}
		}
	}

	return 'unknown error';
}