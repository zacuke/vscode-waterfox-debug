import * as os from 'os';
import * as fs from 'fs-extra';
import * as path from 'path';
import * as uuid from 'uuid';
import * as assert from 'assert';
import * as util from './util';
import * as sourceMapUtil from './sourceMapUtil';
import webpack from 'webpack';
import TerserPlugin from 'terser-webpack-plugin';
import { DebugClient } from 'vscode-debugadapter-testsupport';

const TESTDATA_PATH = path.join(__dirname, '../../testdata/web/sourceMaps/modules');

describe('Webpack sourcemaps: The debugger', function() {

	let dc: DebugClient | undefined;
	let targetDir: string | undefined;

	afterEach(async function() {
		if (dc) {
			await dc.stop();
			dc = undefined;
		}
		if (targetDir) {
			await fs.remove(targetDir);
			targetDir = undefined;
		}
	});

	for (const devtool of [
		'source-map', 'inline-source-map', 'nosources-source-map', 'inline-nosources-source-map',
		'eval-source-map', 'eval-cheap-source-map', 'eval-cheap-module-source-map',
		'eval-nosources-source-map', 'eval-nosources-cheap-source-map', 'eval-nosources-cheap-module-source-map',
	] satisfies Devtool[]) {

		const description = `should map webpack-bundled modules with devtool "${devtool}" to their original sources`;
		const isEvalSourcemap = devtool.indexOf('eval') >= 0;
		const isCheapSourcemap = devtool.indexOf('cheap') >= 0;

		it(description, async function() {

			let targetDir = await prepareTargetDir();

			await build(targetDir, devtool);

			dc = await util.initDebugClient('', true, {
				file: path.join(targetDir, 'index.html'),
				pathMappings: [{ url: 'webpack:///', path: targetDir + '/' }]
			});

			// test breakpoint locations if the devtool provides column breakpoints
			if (!isCheapSourcemap) {
				const breakpointLocations = await dc.customRequest('breakpointLocations', {
					source: { path: path.join(targetDir, 'f.js') },
					line: 7
				});
				assert.deepStrictEqual(breakpointLocations.body.breakpoints, [
					{ line: 7, column: isEvalSourcemap ? 1 : 2 },
					{ line: 7, column: 6 }
				]);
			}

			const breakpoint = { line: 7, column: isEvalSourcemap ? 1 : 6 };
			await sourceMapUtil.testSourcemaps(dc, targetDir, breakpoint);
		});
	}
});

async function prepareTargetDir(): Promise<string> {

	let targetDir = path.join(os.tmpdir(), `vscode-firefox-debug-test-${uuid.v4()}`);
	await fs.mkdir(targetDir);
	await sourceMapUtil.copyFiles(TESTDATA_PATH, targetDir, ['index.html', 'f.js', 'g.js']);

	return targetDir;
}

type Devtool = `${'inline-' | 'hidden-' | 'eval-' | ''}${'nosources-' | ''}${'cheap-module-' | 'cheap-' | ''}source-map`;

function build(targetDir: string, devtool: Devtool): Promise<void> {
	return new Promise<void>((resolve, reject) => {
		webpack({
			context: targetDir,
			entry: './f.js',
			output: {
				path: targetDir,
				filename: 'bundle.js'
			},
			devtool: devtool,
			optimization: {
				minimizer: [new TerserPlugin({ terserOptions: { mangle: false } })],
			}
		}, (err, stats) => {
			if (err) {
				reject(err);
			} else {
				resolve();
			}
		});
	})
}