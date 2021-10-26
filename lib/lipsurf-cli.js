#!/bin/sh
"use strict";
":"; //# comment; exec /usr/bin/env node --no-warnings --experimental-vm-modules "$0" "$@"
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
// #!/usr/bin/env node
const commander_1 = __importDefault(require("commander"));
const child_process_1 = require("child_process");
const globby_1 = __importDefault(require("globby"));
const path_1 = __importDefault(require("path"));
const lodash_1 = require("lodash");
const util_1 = require("./util");
const fs_extra_1 = __importDefault(require("fs-extra"));
const child_process_2 = require("child_process");
const evaluator_1 = require("./evaluator");
const transform_1 = require("./transform");
const ts_compile_1 = require("./ts-compile");
const core_1 = require("@swc/core");
const chokidar_1 = __importDefault(require("chokidar"));
const IS_PROD = process.env.NODE_ENV === "production";
const TMP_DIR = "dist/tmp";
const FOLDER_REGX = /^src\/(.*)\/([^.]*).*$/;
commander_1.default
    .option("-p, --project", "ts config file path", "./tsconfig.json")
    .option("-o, --out-dir <destination>", "destination", "dist");
commander_1.default
    .command("build [...PLUGINS]")
    .description("build lipsurf plugins")
    .option("-w, --watch")
    .option("-t, --check", "check types")
    .option("--no-base-imports")
    .action((plugins, cmdObj) => build(Object.assign(Object.assign({}, cmdObj), cmdObj.parent), plugins));
commander_1.default
    .command("vup")
    .description("up the minor version of all the plugins")
    .option("-v, --version <version>", "specify a version instead of incrementing the minor version by 1")
    .action((cmdObj) => upVersion(Object.assign(Object.assign({}, cmdObj), cmdObj.parent)));
function getAllPluginIds(files) {
    return Array.from(new Set(files
        .map((filePath) => FOLDER_REGX.exec(filePath))
        .filter((regexRes) => regexRes && regexRes[1] === regexRes[2])
        .map((regexRes) => regexRes[1])));
}
function forkAndTransform(pluginIds, ...args) {
    return new Promise((cb) => {
        if (pluginIds.length === 1) {
            (0, transform_1.transformJSToPlugin)(pluginIds[0], ...args).finally(cb);
        }
        else {
            let finishedForks = 0;
            const forks = [];
            for (let pluginId of pluginIds) {
                // forking done as a workaround for bug in SWC:
                // https://github.com/swc-project/swc/issues/1366
                // (but hey, it probably also improves perf)
                const forked = (0, child_process_1.fork)(path_1.default.join(__dirname, "./worker.js"));
                forks.push(forked);
                forked.once("exit", (code) => {
                    finishedForks++;
                });
                forked.send([pluginId, ...args]);
            }
            const checkIfDone = setInterval(() => {
                if (finishedForks >= forks.length) {
                    clearInterval(checkIfDone);
                    cb();
                }
            }, 20);
        }
    });
}
/**
 * How this works:
 *   1. Compile TS
 *   2. Bundle with esbuild (pull imports into same file)
 *   3. Replace called fns with a special string (using SWC parser)
 *   4. Evaluate the JS (using Node.js VM module)
 *   5. Transform the Plugin object to create 7 different parts:
 *       * backend plugin (no changes currently, but in the future should remove things like tests in the prod build)
 *       * matching content script (for each plan - 0, 10, 20)
 *       * non-matching content script (for each plan)
 *   6. Uneval the js object (make into source code again)
 *   7. Replace the previous Plugin object with the new one in the bundled source
 *   8. Remove extraneous code like Plugin.languages
 *   9. Build each part with esbuild again to treeshake and minify
 *
 * @param options
 * @param plugins
 */
async function build(options, plugins = "") {
    const timeStart = new Date();
    let globbedTs;
    let pluginIds;
    if (!plugins.length) {
        globbedTs = globby_1.default.sync(["src/**/*.ts", "!src/@types"]);
        pluginIds = getAllPluginIds(globbedTs);
    }
    else {
        pluginIds = [].concat(plugins.split(","));
        globbedTs = globby_1.default.sync(pluginIds.map((p) => `src/${p}/*.ts`));
    }
    console.log("Building plugins:", pluginIds);
    let envVars = {};
    const isProd = !!(IS_PROD || options.prod);
    const baseImports = typeof options.baseImports !== "undefined" ? options.baseImports : true;
    const envFile = isProd ? ".env" : ".env.development";
    try {
        envVars = (0, util_1.getDotEnv)(path_1.default.join(envFile));
    }
    catch (e) {
        console.warn(`No "${envFile}" file found.`);
    }
    const define = (0, lodash_1.transform)(Object.assign({ NODE_ENV: isProd ? "production" : "development" }, envVars), (r, val, key) => (r[`process.env.${key}`] = `"${(0, util_1.escapeQuotes)(val)}"`));
    if (options.watch) {
        if (options.check) {
            (0, ts_compile_1.watch)(globbedTs, async () => {
                console.log("Starting transform...");
                await forkAndTransform(pluginIds, globbedTs, options.outDir, isProd, baseImports, define);
                console.log("Done transforming.");
            });
        }
        else {
            let queued = false;
            chokidar_1.default.watch("src").on("all", async (event, path) => {
                if (!queued) {
                    queued = true;
                    // just do all of them
                    await transpileFiles(globbedTs);
                    console.log("Starting transform...");
                    await forkAndTransform(pluginIds, globbedTs, options.outDir, isProd, baseImports, define);
                    console.log("Done transforming.");
                    queued = false;
                }
            });
        }
    }
    else {
        if (options.check)
            await (0, ts_compile_1.compile)(globbedTs);
        else {
            await transpileFiles(globbedTs);
        }
        await forkAndTransform(pluginIds, globbedTs, options.outDir, isProd, baseImports, define);
        const timeEnd = new Date();
        console.log(`Done building in ${((+timeEnd - +timeStart) / 1000).toFixed(2)} seconds.`);
    }
}
function transpileFiles(globbedTs) {
    return Promise.all(globbedTs.map((f) => (0, core_1.transformFile)(f, {
        jsc: {
            parser: {
                syntax: "typescript",
                dynamicImport: true,
            },
            target: "es2020",
            // externalHelpers: true,
        },
    }).then((t) => {
        const splitted = f.split(/\.ts|\//g);
        let dir;
        if (splitted.length > 3)
            dir = `${TMP_DIR}/${splitted[splitted.length - 3]}`;
        else
            dir = TMP_DIR;
        const outputF = `${dir}/${splitted[splitted.length - 2]}.js`;
        return fs_extra_1.default.ensureDir(dir).then(() => fs_extra_1.default.writeFile(outputF, t.code));
    })));
}
async function upVersion(options) {
    // make sure there are no unexpected changes so that we don't include them in the upversion commit
    try {
        (0, child_process_2.execSync)("git diff-index --ignore-submodules --quiet HEAD -- ./").toString();
    }
    catch (e) {
        throw new Error(`There are uncommitted things. Commit them before running vup.`);
    }
    // first find a plugin file
    const globbedTs = globby_1.default.sync(["src/*/*.ts", "!src/@types"]);
    const pluginIds = getAllPluginIds(globbedTs);
    const anyPluginName = pluginIds[0];
    const parDir = `${options.outDir}/tmp`;
    try {
        await fs_extra_1.default.readdir(parDir);
    }
    catch (e) {
        console.warn(`Expected temporary build plugin files in ${parDir}. Building first. We need these to read the .mjs plugins (can't read ts directly for now) and extract a current version.`);
        await build(options);
    }
    const oldVersion = (await (0, evaluator_1.evalPlugin)(await fs_extra_1.default.readFile(`./${TMP_DIR}/${anyPluginName}/${anyPluginName}.js`, "utf8"), `./${TMP_DIR}/${anyPluginName}/`)).version;
    console.log(`latest version of ${anyPluginName}: ${oldVersion}`);
    const packageJsonVersion = JSON.parse(await fs_extra_1.default.readFile("./package.json", "utf8")).version;
    const newVersion = options.version || packageJsonVersion;
    console.log(`upping to: ${newVersion}`);
    // HACK: this is crude, and could f'up code that has "version: "..." in it"
    (0, child_process_2.execSync)(`sed -i 's/version: "${oldVersion}"/version: "${newVersion}"/g' src/*/*.ts`);
    await build(Object.assign(Object.assign({}, options), { prod: true }));
    // remove the old plugins
    try {
        (0, child_process_2.execSync)(`rm dist/*.${oldVersion.replace(/\./g, "-")}.*.ls`);
    }
    catch (e) {
        console.warn("error removing old version's files");
    }
    // make an vup commit (version tagging is done by the parent repo -- which determines which commit actually gets into the extension's package)
    (0, child_process_2.execSync)("git add src dist");
    // no longer doing this in the mono repo
    // execSync(`git commit -m "Version upped from ${oldVersion} to ${newVersion}" -a`);
}
commander_1.default.parseAsync(process.argv).catch((e) => {
    console.error(e);
    process.exit(1);
});
