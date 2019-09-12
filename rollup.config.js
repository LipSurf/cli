const html = require('rollup-plugin-html');
const typescript = require('rollup-plugin-typescript2');
const { terser } = require("rollup-plugin-terser");
const multiEntry = require("rollup-plugin-multi-entry");
const resolve = require("rollup-plugin-node-resolve");
const globby = require('globby');
const commonjs = require('rollup-plugin-commonjs');
const fs = require('fs');
const JSCodeShift = require('jscodeshift').run;

const makeCS = require('./rollup-plugin-make-cs');

// require('ts-node/register');
// const ParsedPlugin = require('./transforms/ParsedPlugin').default;

const PROD = process.env.NODE_ENV === 'production';
const PLANS = ['0', '10', '20'];
const PLANS_AND_PARTS = ['backend', ...[].concat.apply([], ['matching.cs', 'nonmatching.cs'].map(cs => PLANS.map(plan => `${plan}.${cs}`)))];

module.exports = async function getConfig(finalOutputDir, pluginNames) {
	return (await Promise.all(pluginNames.map(async pluginName => {
		// const pluginVersion = babelParser.parse(`src/${pluginName}/${pluginName}.ts`, {
		// 	sourceType: 'module',
		// 	plugins: [
		// 		'typescript',
		// 	],
		// });
		// const mainPath = `src/${pluginName}/${pluginName}.ts`;
		// const src = fs.readFileSync(mainPath).toString();
		// const parsedPlugin = new ParsedPlugin(JSCodeShift, src);
		// const version = parsedPlugin.getVersion();
		// console.log(version);
		// debugger;
		// return;
		const version = '2.7.0'.replace(/\./g, '-');
		return [{
			input: [
				`src/${pluginName}/${pluginName}.ts`,
				`src/${pluginName}/${pluginName}.*.ts`,
			],
			treeshake: false,
			plugins: [
				multiEntry(),
				resolve({
					preferBuiltins: false,
				}),
				commonjs(),
				typescript(),
			],
			output: {
				// garbage since we use jscodeshift on the cmd line
				file: `dist/tmp/${pluginName}.joined.mjs`,
				format: 'esm',
			}
		},
		{
			input: `dist/tmp/${pluginName}.joined.mjs`,
			treeshake: false,
			plugins: [
				{
					/**
					 * Trim down for matching and non-matching URL frontend CS
					 */
					generateBundle(options, bundle, isWrite) {
						if (isWrite) {
							// async/await syntax messes shiz up
							return new Promise(async cb => {
								// make this the node_modules path instead
								await JSCodeShift('/home/mikob/workspace/lipsurf/lipsurf-cli/transforms/split.ts', [`dist/tmp/${pluginName}.joined.mjs`], {
									transform: './node_modules/lipsurf-cli/transforms/split.ts',
									verbose: 2,
									runInBand: true,

									dry: false,
									print: false,
									babel: true,
									extensions: 'js,mjs',
									ignorePattern: [],
									ignoreConfig: [],
									silent: false,
									parser: 'babel',
									stdin: false
								});

								for (let planAndPart of PLANS_AND_PARTS) {
									const pattern = `dist/tmp/${pluginName}.*.${planAndPart}.js`;
									const fileParts = globby.sync(pattern);
									if (fileParts.length !== 1) {
										console.error(`Not exactly one file for ${pluginName}`);
										console.log(fileParts);
										return;
									}
									const filePartName = fileParts[0].split('dist/tmp/')[1];
									try {
										const source = await fs.readFileSync(`dist/tmp/${filePartName}`);
										bundle[filePartName] = {
											isAsset: true,
											fileName: filePartName,
											source,
										};
									} catch (e) {
										if (e.code !== 'ENOENT')
											console.log(`${filePartName} problem`, e);
									}
								}
								cb();
							});
						}
					}
				}
			],
			output: {
				// garbage since we use jscodeshift on the cmd line
				file: `/tmp/${pluginName}.garbage.js`,
				format: 'esm',
			}
		},
		// to prevent chunking external deps, do the files one by one :( (rollup shortcoming)
		// hack: manually including version
		...PLANS_AND_PARTS.map(planAndPart => `dist/tmp/${pluginName}.${version}.${planAndPart}.js`).map(filename => ({
			// don't use globby.sync because it resolves before files are ready
			input: filename,
			treeshake: {
				moduleSideEffects: false,
				pureExternalModules: true,
			},
			plugins: [
				html({
					include: '**/*.html',
					htmlMinifierOptions: {
						collapseWhitespace: true,
						collapseBooleanAttributes: true,
						conservativeCollapse: true,
						minifyJS: true,
						minifyCSS: true,
						removeComments: true,
					}
				}),
				PROD && terser({
					mangle: false,
					compress: {
						pure_funcs: [
							'console.log',
							'console.dir',
						]
					}
				}),
			],
			output: {
				format: 'esm',
				file: `${filename.split('.js')[0]}.resolved.js`
			}
		})),
		{
			// hack, manually including version in the input file name
			input: PLANS_AND_PARTS.map(planAndPart => `dist/tmp/${pluginName}.${version}.${planAndPart}.resolved.js`),
			plugins: [
				makeCS(),
			],
			output: {
				format: 'esm',
				dir: finalOutputDir,
			}
		}
	];
	}
	))).flat();
}
