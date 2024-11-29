const path = require('path');
const CopyPlugin = require('copy-webpack-plugin');

module.exports = {
	context: path.resolve(__dirname, 'src'),
	entry: {
		extension: './extension/main.ts',
		adapter: './adapter/waterfoxDebugAdapter.ts',
		launcher: './adapter/util/forkedLauncher.ts'
	},
	resolve: {
		extensions: [ '.js', '.ts' ]
	},
	module: {
		rules: [
			{
				test: /\.ts$/,
				loader: 'babel-loader'
			}
		]
	},
	externals: {
		vscode: 'commonjs vscode',
		fsevents: 'commonjs fsevents'
	},
	output: {
		path: path.resolve(__dirname, 'dist'),
		filename: '[name].bundle.js',
		libraryTarget: 'commonjs2',
		devtoolModuleFilenameTemplate: '../src/[resource-path]'
	},
	target: 'node',
	node: {
		__dirname: false
	},
	plugins: [
		new CopyPlugin({
			patterns: [
				path.resolve(__dirname, 'node_modules/source-map/lib/mappings.wasm'),
				path.resolve(__dirname, 'LICENSE')
			]
		})
	],
	devtool: 'source-map'
};
