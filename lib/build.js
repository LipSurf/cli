"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.getAllPluginIds = exports.build = exports.TMP_DIR = void 0;
const fs_extra_1 = __importDefault(require("fs-extra"));
const transform_1 = __importDefault(require("lodash/transform"));
const util_1 = require("./util");
const ts_compile_1 = require("./ts-compile");
const chokidar_1 = __importDefault(require("chokidar"));
const globby_1 = __importDefault(require("globby"));
const transform_2 = require("./transform");
const core_1 = require("@swc/core");
const path_1 = __importDefault(require("path"));
const child_process_1 = require("child_process");
const log_1 = require("./log");
exports.TMP_DIR = "dist/tmp";
const IS_PROD = process.env.NODE_ENV === "production";
const FOLDER_REGX = /^src\/(.*)\/([^.]*).*$/;
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
async function build(options, plugins = []) {
    const timeStart = new Date();
    let globbedTs;
    let pluginIds;
    if (!plugins.length) {
        globbedTs = globby_1.default.sync(["src/**/*.ts", "!src/@types"]);
        pluginIds = getAllPluginIds(globbedTs);
    }
    else if (plugins[0].endsWith(".ts")) {
        // specific files
        globbedTs = plugins;
        pluginIds = plugins.map((p) => p.substring(p.lastIndexOf("/") + 1, p.length - 3));
    }
    else {
        // plugin ids
        globbedTs = globby_1.default.sync([
            ...plugins.map((id) => `src/${id}/*.ts`),
            "!src/@types",
        ]);
        pluginIds = plugins;
    }
    (0, log_1.timedLog)("Building plugins:", pluginIds);
    if (globbedTs.length === 0) {
        throw new Error("No plugins found. Pass a [PLUGIN_PATH] or put plugins in src/[plugin name]/[plugin name].ts");
    }
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
    const define = (0, transform_1.default)(Object.assign({ NODE_ENV: isProd ? "production" : "development" }, envVars), (r, val, key) => (r[`process.env.${key}`] = `"${(0, util_1.escapeQuotes)(val)}"`));
    if (options.watch) {
        if (options.check) {
            (0, ts_compile_1.watch)(globbedTs, async () => {
                (0, log_1.timedLog)("Starting transform...");
                await forkAndTransform(pluginIds, globbedTs, options.outDir, isProd, baseImports, define);
                (0, log_1.timedLog)("Done transforming.");
            });
        }
        else {
            let queued = false;
            chokidar_1.default.watch(globbedTs).on("all", async (event, path) => {
                if (!queued) {
                    queued = true;
                    // just do all of them
                    await transpileFiles(globbedTs);
                    (0, log_1.timedLog)("Starting transform...");
                    await forkAndTransform(pluginIds, globbedTs, options.outDir, isProd, baseImports, define);
                    (0, log_1.timedLog)("Done transforming.");
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
        (0, log_1.timedLog)(`Done building in ${((+timeEnd - +timeStart) / 1000).toFixed(2)} seconds.`);
    }
}
exports.build = build;
function getAllPluginIds(files) {
    return Array.from(new Set(files
        .map((filePath) => FOLDER_REGX.exec(filePath))
        .filter((regexRes) => regexRes && regexRes[1] === regexRes[2])
        .map((regexRes) => regexRes[1])));
}
exports.getAllPluginIds = getAllPluginIds;
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
            dir = `${exports.TMP_DIR}/${splitted[splitted.length - 3]}`;
        else
            dir = exports.TMP_DIR;
        const outputF = `${dir}/${splitted[splitted.length - 2]}.js`;
        return fs_extra_1.default.ensureDir(dir).then(() => fs_extra_1.default.writeFile(outputF, t.code));
    })));
}
function forkAndTransform(pluginIds, ...args) {
    return new Promise((cb) => {
        if (pluginIds.length === 1) {
            (0, transform_2.transformJSToPlugin)(pluginIds[0], ...args).finally(cb);
        }
        else {
            let finishedForks = 0;
            const forks = [];
            for (let pluginId of pluginIds) {
                // forking done as a workaround for bug in SWC:
                // https://github.com/swc-project/swc/issues/1366
                // (but hey, it probably also improves perf)
                const forked = (0, child_process_1.fork)(path_1.default.join(__dirname, "./worker.js"), {
                    env: Object.assign({ NODE_NO_WARNINGS: "1", NODE_OPTIONS: "--experimental-vm-modules" }, process.env),
                });
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
