const html = require('rollup-plugin-html');
const typescript = require('rollup-plugin-typescript2');
const { terser } = require("rollup-plugin-terser");
const multiEntry = require("rollup-plugin-multi-entry");
const resolve = require("rollup-plugin-node-resolve");
const makeCS = require('./rollup-plugin-make-cs');
const globby = require('globby');

const util = require('util');
const path = require('path');
const child_process = require('child_process');
const exec = util.promisify(child_process.exec);
const JSCodeShift = require('jscodeshift').run;
const fs = require('fs');

const PROD = process.env.NODE_ENV === 'production';
const FOLDER_REGX = /^src\/(.*)\/.*$/;

module.exports = [].concat(...globby.sync(['src/**/*.ts', '!src/@types', '!src/**/*.*.ts']).map(fileName => {
	let regxRes = FOLDER_REGX.exec(fileName);
	let folderName = regxRes ? regxRes[1] : null;
	if (folderName) {
		return [
			{
				input: `src/${folderName}/*.ts`,
				treeshake: false,
				plugins: [
					multiEntry(),
					typescript(),
					{
						/**
						 * Trim down for matching and non-matching URL frontend CS
						 */
						generateBundle(options, bundle) {
							// async/await syntax messes shiz up
							return new Promise(async cb => {
								const k = Object.keys(bundle)[0];
								const code = bundle[k].code;
								// hack until jscodeshift supports js api
								const joinedFileName = path.resolve(`dist/${folderName}.joined.mjs`);
								await fs.writeFileSync(joinedFileName, code);
								
								let res = await JSCodeShift('/home/mikob/workspace/lipsurf/chrome-extension/plugins/node_modules/lipsurf-cli/transforms/split.ts', [joinedFileName], {
									transform: './node_modules/lipsurf-cli/transforms/split.ts',
									verbose: 2,

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
								const matchingCSFile = `${folderName}.matching.cs.js`;
								bundle[matchingCSFile] = {
									isAsset: true,
									fileName: matchingCSFile,
									source: await fs.readFileSync(`dist/${matchingCSFile}`),
								};
								cb();
							});
						}
					}
				],
				output: {
					// garbage since we use jscodeshift on the cmd line
					file: `dist/${folderName}.backend.js`,
					format: 'esm',
				}
			},
			{
				// don't use globby.sync because it resolves before files are ready
				input: [`dist/${folderName}.matching.cs.js`, `dist/${folderName}.backend.js`],
				treeshake: {
					moduleSideEffects: false,
					pureExternalModules: true,
				},
				external: ["lodash-es"],
				plugins: [
					resolve(),
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
					makeCS(),
				],
				output: {
					format: 'esm',
					dir: 'dist',
					// file: `dist/${folderName}.ls`
				}
			},
		];
	}
}).filter(a => a));
