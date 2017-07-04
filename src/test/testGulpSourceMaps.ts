import * as os from 'os';
import * as fs from 'fs-extra';
import * as path from 'path';
import * as uuid from 'uuid';
import * as util from './util';
import * as sourceMapUtil from './sourceMapUtil';
import * as gulp from 'gulp';
import * as sourcemaps from 'gulp-sourcemaps';
import * as uglify from 'gulp-uglify';
import * as rename from 'gulp-rename';
import * as concat from 'gulp-concat';
import * as mapSources from '@gulp-sourcemaps/map-sources';
import { DebugClient } from "vscode-debugadapter-testsupport";

const TESTDATA_PATH = path.join(__dirname, '../../testdata/web/sourceMaps/scripts');

describe('Firefox debug adapter', function() {

	let dc: DebugClient | undefined;

	afterEach(async function() {
		if (dc) {
			await dc.stop();
			dc = undefined;
		}
	});

	// tests with client-side source-maps disabled until Firefox bug #1373632 is fixed
	for (let sourceMaps of [ 'server' /*, 'client'*/ ]) {
	for (let bundleScripts of [false, true]) {
	for (let embedSourceMap of [false, true]) {
	for (let separateBuildDir of [false, true]) {

		let descr = 
			`should map minified${bundleScripts ? ', bundled' : ''} scripts ` +
			`to their original sources in ${separateBuildDir ? 'a different' : 'the same'} directory ` +
			`using an ${embedSourceMap ? 'embedded' : 'external'} source-map handled by the ${sourceMaps}`;

		it(descr, async function() {

			let { targetDir, srcDir, buildDir } = prepareTargetDir(bundleScripts, separateBuildDir);

			await build(buildDir, bundleScripts, embedSourceMap, separateBuildDir);

			dc = await util.initDebugClient('', true, {
 				file: path.join(buildDir, 'index.html'),
 				sourceMaps
 			});
 
			await sourceMapUtil.testSourcemaps(dc, srcDir);

			fs.removeSync(targetDir);
		});
	}}}}
});

interface TargetPaths {
	targetDir: string;
	srcDir: string;
	buildDir: string;
}

function prepareTargetDir(
	bundle: boolean,
	separateBuildDir: boolean
): TargetPaths {

	let targetDir = path.join(os.tmpdir(), `vscode-firefox-debug-test-${uuid.v4()}`);
	fs.mkdirSync(targetDir);
	let scriptTags = bundle ? ['bundle.js'] : ['f.min.js', 'g.min.js'];

	if (!separateBuildDir) {

		sourceMapUtil.copyFiles(TESTDATA_PATH, targetDir, ['index.html', 'f.js', 'g.js']);
		sourceMapUtil.injectScriptTags(targetDir, scriptTags);

		return { targetDir, srcDir: targetDir, buildDir: targetDir };

	} else {

		let srcDir = path.join(targetDir, 'src');
		fs.mkdirSync(srcDir);
		let buildDir = path.join(targetDir, 'build');
		fs.mkdirSync(buildDir);

		sourceMapUtil.copyFiles(TESTDATA_PATH, srcDir, ['f.js', 'g.js']);
		sourceMapUtil.copyFiles(TESTDATA_PATH, buildDir, ['index.html']);
		sourceMapUtil.injectScriptTags(buildDir, scriptTags);

		return { targetDir, srcDir, buildDir };
	}
}

function build(
	buildDir: string,
	bundleScripts: boolean,
	embedSourceMap: boolean,
	separateBuildDir: boolean
): Promise<void> {

	return sourceMapUtil.waitForStreamEnd(
		gulp.src(path.join(buildDir, separateBuildDir ? '../src/*.js' : '*.js'))
		.pipe(sourcemaps.init())
		.pipe(uglify({ mangle: false }))
		.pipe(bundleScripts ? concat('bundle.js') : rename((path) => { path.basename += '.min'; }))
		.pipe(mapSources((srcPath) => separateBuildDir ? '../src/' + srcPath : srcPath))
		.pipe(sourcemaps.write(embedSourceMap ? undefined : '.', { includeContent: false }))
		.pipe(gulp.dest(buildDir)));
}
