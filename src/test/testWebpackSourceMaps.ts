import * as os from 'os';
import * as fs from 'fs-extra';
import * as path from 'path';
import * as uuid from 'uuid';
import * as util from './util';
import * as sourceMapUtil from './sourceMapUtil';
import * as webpack from 'webpack';
import { DebugClient } from "vscode-debugadapter-testsupport";

const TESTDATA_PATH = path.join(__dirname, '../../testdata/web/sourceMaps/modules');

describe('Firefox debug adapter', function() {

	let dc: DebugClient | undefined;

	afterEach(async function() {
		if (dc) {
			await dc.stop();
			dc = undefined;
		}
	});

	for (let sourceMaps of [ 'server', 'client' ]) {
	for (let devtool of [
		'cheap-eval-source-map', 'cheap-source-map', 'cheap-module-eval-source-map', 'inline-source-map',
		'cheap-module-source-map' , 'eval-source-map' , 'source-map' , 'nosources-source-map'
	]) {

		it(`should map webpack-bundled modules with devtool "${devtool}" to their original sources with source-maps handled by the ${sourceMaps}`, async function() {

			let targetDir = prepareTargetDir();

			await build(targetDir, <Devtool>devtool);

			dc = await util.initDebugClient('', true, {
				file: path.join(targetDir, 'index.html'),
				pathMappings: [{ url: 'webpack:///', path: targetDir + '/' }],
				sourceMaps
			});

			await sourceMapUtil.testSourcemaps(dc, targetDir, 4);

			fs.removeSync(targetDir);
		});
	}}
});

function prepareTargetDir(): string {

	let targetDir = path.join(os.tmpdir(), `vscode-firefox-debug-test-${uuid.v4()}`);
	fs.mkdirSync(targetDir);
	sourceMapUtil.copyFiles(TESTDATA_PATH, targetDir, ['index.html', 'f.js', 'g.js']);

	return targetDir;
}

type Devtool = 
	'cheap-eval-source-map' | 'cheap-source-map' | 'cheap-module-eval-source-map' | 'inline-source-map' |
	'cheap-module-source-map' | 'eval-source-map' | 'source-map' | 'nosources-source-map';

function build(targetDir: string, devtool: Devtool): Promise<void> {
	return new Promise<void>((resolve, reject) => {
		webpack({
			context: targetDir,
			entry: './f.js',
			output: {
				path: targetDir,
				filename: 'bundle.js'
			},
			devtool: devtool
		}, (err, stats) => {
			if (err) {
				reject(err);
			} else {
				resolve();
			}
		});
	})
}