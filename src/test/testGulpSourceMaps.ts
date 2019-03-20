import * as os from 'os';
import * as fs from 'fs-extra';
import * as path from 'path';
import * as uuid from 'uuid';
import * as util from './util';
import * as sourceMapUtil from './sourceMapUtil';
import * as gulp from 'gulp';
import * as nop from 'gulp-nop';
import * as sourcemaps from 'gulp-sourcemaps';
import * as uglify from 'gulp-uglify';
import * as rename from 'gulp-rename';
import * as concat from 'gulp-concat';
import * as mapSources from '@gulp-sourcemaps/map-sources';
import { DebugClient } from "vscode-debugadapter-testsupport";

const TESTDATA_PATH = path.join(__dirname, '../../testdata/web/sourceMaps/scripts');

describe('Gulp sourcemaps: The debugger', function() {

	let dc: DebugClient | undefined;

	afterEach(async function() {
		if (dc) {
			await dc.stop();
			dc = undefined;
		}
	});

	for (let sourceMaps of [ 'server', 'client' ]) {
	for (let minifyScripts of [false, true]) {
	for (let bundleScripts of [false, true]) {
	for (let embedSourceMap of [false, true]) {
	for (let separateBuildDir of [false, true]) {

		// we need to apply at least one transformation, otherwise no sourcemap will be generated
		if (!minifyScripts && !bundleScripts) continue;

		const transformations: string[] = [];
		if (minifyScripts) transformations.push('minified');
		if (bundleScripts) transformations.push('bundled');
		let descr = 
			`should map ${transformations.join(', ')} scripts ` +
			`to their original sources in ${separateBuildDir ? 'a different' : 'the same'} directory ` +
			`using an ${embedSourceMap ? 'embedded' : 'external'} source-map handled by the ${sourceMaps}`;

		if (minifyScripts && (sourceMaps === 'client')) {
			// tests with minified scripts and client-side source-maps disabled until Firefox bug #1373632 is fixed
			it.skip(descr, function(){});
			continue;
		}

		// server-side source-maps are not supported with Firefox >= 66.0
		if ((process.env['NEW_STEP_OUT_BEHAVIOR'] === 'true') && (sourceMaps === 'server')) {
			it.skip(descr);
			continue;
		}

		it(descr, async function() {

			let { targetDir, srcDir, buildDir } = await prepareTargetDir(bundleScripts, separateBuildDir);

			await build(buildDir, minifyScripts, bundleScripts, embedSourceMap, separateBuildDir);

			dc = await util.initDebugClient('', true, {
 				file: path.join(buildDir, 'index.html'),
 				sourceMaps
 			});
 
			await sourceMapUtil.testSourcemaps(dc, srcDir);

			await fs.remove(targetDir);
		});
	}}}}}
});

interface TargetPaths {
	targetDir: string;
	srcDir: string;
	buildDir: string;
}

async function prepareTargetDir(
	bundle: boolean,
	separateBuildDir: boolean
): Promise<TargetPaths> {

	let targetDir = path.join(os.tmpdir(), `vscode-firefox-debug-test-${uuid.v4()}`);
	await fs.mkdir(targetDir);
	let scriptTags = bundle ? ['bundle.js'] : ['f.min.js', 'g.min.js'];

	if (!separateBuildDir) {

		await sourceMapUtil.copyFiles(TESTDATA_PATH, targetDir, ['index.html', 'f.js', 'g.js']);
		await sourceMapUtil.injectScriptTags(targetDir, scriptTags);

		return { targetDir, srcDir: targetDir, buildDir: targetDir };

	} else {

		let srcDir = path.join(targetDir, 'src');
		await fs.mkdir(srcDir);
		let buildDir = path.join(targetDir, 'build');
		await fs.mkdir(buildDir);

		await sourceMapUtil.copyFiles(TESTDATA_PATH, srcDir, ['f.js', 'g.js']);
		await sourceMapUtil.copyFiles(TESTDATA_PATH, buildDir, ['index.html']);
		await sourceMapUtil.injectScriptTags(buildDir, scriptTags);

		return { targetDir, srcDir, buildDir };
	}
}

function build(
	buildDir: string,
	minifyScripts: boolean,
	bundleScripts: boolean,
	embedSourceMap: boolean,
	separateBuildDir: boolean
): Promise<void> {

	return sourceMapUtil.waitForStreamEnd(
		gulp.src(path.join(buildDir, separateBuildDir ? '../src/*.js' : '*.js'))
		.pipe(sourcemaps.init())
		.pipe(minifyScripts ? uglify({ mangle: false }) : nop())
		.pipe(bundleScripts ? concat('bundle.js') : rename((path) => { path.basename += '.min'; }))
		.pipe(mapSources((srcPath) => separateBuildDir ? '../src/' + srcPath : srcPath))
		.pipe(sourcemaps.write(embedSourceMap ? undefined : '.', { includeContent: false }))
		.pipe(gulp.dest(buildDir)));
}
