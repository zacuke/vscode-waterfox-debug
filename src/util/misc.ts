export function concatArrays<T>(arrays: T[][]): T[] {
	return [].concat.apply([], arrays);
}
