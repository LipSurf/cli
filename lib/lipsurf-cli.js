#!/bin/sh
"use strict";
":"; //# comment; exec /usr/bin/env node --no-warnings --experimental-vm-modules "$0" "$@"
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
// #!/usr/bin/env node
const commander_1 = require("commander");
const child_process_1 = require("child_process");
const globby_1 = __importDefault(require("globby"));
const fs_extra_1 = __importDefault(require("fs-extra"));
const child_process_2 = require("child_process");
const evaluator_1 = require("./evaluator");
const fs_1 = require("fs");
const js_beautify_1 = __importDefault(require("js-beautify"));
const templates_1 = require("./templates");
const build_1 = require("./build");
const log_1 = require("./log");
const version = JSON.parse(fs_extra_1.default.readFileSync("./package.json", "utf8")).version;
// --- hack until @lipsurf/common is available here
const PLUGIN_SPLIT_SEQ = "\vLS-SPLIT";
// --- end hack
commander_1.program
    .command("build [PLUGIN_PATHS_OR_IDS...]")
    .description("Build LipSurf plugins. By default builds all plugins under src/ within a directory of the plugin's name.")
    .option("-w, --watch")
    .option("-t, --check", "check TypeScript types")
    .option("--no-base-imports")
    .action((plugins, cmdObj) => (0, build_1.build)(cmdObj, plugins));
commander_1.program
    .command("init <project_name>")
    .description("Makes a template plugin which is useful as a starting point.")
    .action((cmdObj) => init(cmdObj));
commander_1.program
    .command("vup")
    .description("Increase (version up) the semver minor version of all the plugins.")
    .option("-v, --version <version>", "specify a version instead of incrementing the minor version by 1")
    .action((cmdObj) => upVersion(Object.assign(Object.assign({}, cmdObj), cmdObj.parent)));
commander_1.program
    .command("beautify <plugin_paths...>")
    .description("Beautify a *.ls plugin file in-place so it's easier to read. Note that plugin file will still be readable by LipSurf.")
    .action((pluginPaths) => {
    for (const pluginPath of pluginPaths) {
        fs_extra_1.default.readFile(pluginPath, "utf8", function (err, data) {
            if (err) {
                throw err;
            }
            const splitted = data.split(PLUGIN_SPLIT_SEQ);
            const parts = splitted.map((x) => (0, js_beautify_1.default)(x, { indent_size: 2, space_in_empty_paren: true }));
            fs_extra_1.default.writeFileSync(pluginPath, parts.join(`\n${PLUGIN_SPLIT_SEQ}\n`));
        });
    }
});
commander_1.program.commands.forEach((cmd) => {
    // @ts-ignore
    if (["vup", "build"].includes(cmd._name)) {
        cmd.option("-p, --project", "tsconfig file path", "./tsconfig.json");
        cmd.option("-o, --out-dir <destination>", "destination directory", "dist");
    }
});
function init(id) {
    return new Promise((cb) => {
        const pkgJson = templates_1.PACKAGE_JSON;
        const root = `lipsurf-plugin-${id.toLowerCase()}`;
        const path = `${root}/src/${id}/`;
        pkgJson.name = root;
        (0, fs_1.mkdirSync)(root);
        (0, fs_1.mkdirSync)(`${root}/src`);
        (0, fs_1.mkdirSync)(path);
        (0, fs_1.writeFileSync)(`${root}/tsconfig.json`, templates_1.TSCONFIG_TEMPLATE);
        (0, fs_1.writeFileSync)(`${root}/package.json`, JSON.stringify(pkgJson, null, 2));
        (0, fs_1.writeFileSync)(`${path}${id}.ts`, templates_1.PLUGIN_TEMPLATE);
        const child = (0, child_process_1.spawn)("yarn", ["install"], { cwd: root, stdio: "pipe" });
        child.stdout.setEncoding("utf8");
        child.stdout.on("data", function (data) {
            (0, log_1.timedLog)(data);
        });
        child.stderr.setEncoding("utf8");
        child.stderr.on("data", function (data) {
            (0, log_1.timedErr)(data);
        });
        child.on("close", function (code) {
            if (code === 0)
                console.log(`Successfully created project ${id}. Now try \`cd ${root}\`, editing src/${id}/${id}.ts then \`yarn watch\`.`);
            else {
                console.error("Could not create project.");
            }
            cb();
        });
    });
}
async function upVersion(options) {
    // make sure there are no unexpected changes so that we don't include them in the upversion commit
    try {
        (0, child_process_2.execSync)(
        // package.json might have a version increment, that's not commited yet (e.g. when using lerna)
        "git diff-index --ignore-submodules --quiet HEAD -- './:!package.json'").toString();
    }
    catch (e) {
        throw new Error(`There are uncommitted things. Commit them before running vup.`);
    }
    // first find a plugin file
    const globbedTs = globby_1.default.sync(["src/*/*.ts", "!src/@types"]);
    const pluginIds = (0, build_1.getAllPluginIds)(globbedTs);
    const anyPluginName = pluginIds[0];
    const parDir = `${options.outDir}/tmp`;
    try {
        await fs_extra_1.default.readdir(parDir);
    }
    catch (e) {
        console.warn(`Expected temporary build plugin files in ${parDir}. Building first. We need these to read the .mjs plugins (can't read ts directly for now) and extract a current version.`);
        await (0, build_1.build)(options);
    }
    const oldVersion = (await (0, evaluator_1.evalPlugin)(await fs_extra_1.default.readFile(`./${build_1.TMP_DIR}/${anyPluginName}/${anyPluginName}.js`, "utf8"), `./${build_1.TMP_DIR}/${anyPluginName}/`)).version;
    console.log(`latest version of ${anyPluginName}: ${oldVersion}`);
    const packageJsonVersion = JSON.parse(await fs_extra_1.default.readFile("./package.json", "utf8")).version;
    const newVersion = options.version || packageJsonVersion;
    console.log(`upping to: ${newVersion}`);
    // HACK: this is crude, and could f'up code that has "version: "..." in it"
    (0, child_process_2.execSync)(`sed -i 's/version: "${oldVersion}"/version: "${newVersion}"/g' src/*/*.ts`);
    await (0, build_1.build)(Object.assign(Object.assign({}, options), { prod: true }));
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
commander_1.program.version(version);
commander_1.program.parseAsync(process.argv).catch((e) => {
    console.error(e);
    process.exit(1);
});
