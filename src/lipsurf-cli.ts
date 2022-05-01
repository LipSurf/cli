#!/bin/sh
":"; //# comment; exec /usr/bin/env node --no-warnings --experimental-vm-modules "$0" "$@"
// #!/usr/bin/env node
import { program } from "commander";
import { spawn } from "child_process";
import globby from "globby";
import fs from "fs-extra";
import { execSync } from "child_process";
import { evalPlugin } from "./evaluator";
import { mkdirSync, writeFileSync } from "fs";
import beautify from "js-beautify";
import { PACKAGE_JSON, PLUGIN_TEMPLATE, TSCONFIG_TEMPLATE } from "./templates";
import { build, TMP_DIR, getAllPluginIds } from "./build";
import { timedErr, timedLog } from "./log";
import { join } from "path";
// ESM way
// import { dirname, join } from "path";
// import { fileURLToPath } from "url";

// const __dirname = dirname(fileURLToPath(import.meta.url));
const version = JSON.parse(
  fs.readFileSync(join(__dirname, "..", "package.json"), "utf8")
).version;

// --- hack until @lipsurf/common is available here
const PLUGIN_SPLIT_SEQ = "\vLS-SPLIT";
// --- end hack

program
  .command("build [PLUGIN_PATHS_OR_IDS...]")
  .description(
    "Build LipSurf plugins. By default builds all plugins under src/ within a directory of the plugin's name."
  )
  .option("-w, --watch")
  .option("-t, --check", "check TypeScript types")
  .option("--no-base-imports")
  .action((plugins, cmdObj) => build(cmdObj, plugins));

program
  .command("init <project_name>")
  .description("Makes a template plugin which is useful as a starting point.")
  .action((cmdObj) => init(cmdObj));

program
  .command("vup")
  .description(
    "Increase (version up) the semver minor version of all the plugins."
  )
  .option(
    "-v, --version <version>",
    "specify a version instead of incrementing the minor version by 1"
  )
  .action((cmdObj) => upVersion({ ...cmdObj, ...cmdObj.parent }));

program
  .command("beautify <plugin_paths...>")
  .description(
    "Beautify a *.ls plugin file in-place so it's easier to read. Note that plugin file will still be readable by LipSurf."
  )
  .action((pluginPaths) => {
    for (const pluginPath of pluginPaths) {
      fs.readFile(pluginPath, "utf8", function (err, data) {
        if (err) {
          throw err;
        }
        const splitted = data.split(PLUGIN_SPLIT_SEQ);
        const parts = splitted.map((x) =>
          beautify(x, { indent_size: 2, space_in_empty_paren: true })
        );
        fs.writeFileSync(pluginPath, parts.join(`\n${PLUGIN_SPLIT_SEQ}\n`));
      });
    }
  });

program.commands.forEach((cmd) => {
  // @ts-ignore
  if (["vup", "build"].includes(cmd._name)) {
    cmd.option("-p, --project", "tsconfig file path", "./tsconfig.json");
    cmd.option("-o, --out-dir <destination>", "destination directory", "dist");
  }
});

function init(id: string) {
  return new Promise<void>((cb) => {
    const pkgJson = PACKAGE_JSON;
    const root = `lipsurf-plugin-${id.toLowerCase()}`;
    const path = `${root}/src/${id}/`;
    pkgJson.name = root;
    mkdirSync(root);
    mkdirSync(`${root}/src`);
    mkdirSync(path);
    writeFileSync(`${root}/tsconfig.json`, TSCONFIG_TEMPLATE);
    writeFileSync(`${root}/package.json`, JSON.stringify(pkgJson, null, 2));
    writeFileSync(`${path}${id}.ts`, PLUGIN_TEMPLATE);
    const child = spawn("yarn", ["install"], { cwd: root, stdio: "pipe" });

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", function (data) {
      timedLog(data);
    });

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", function (data) {
      timedErr(data);
    });

    child.on("close", function (code) {
      if (code === 0)
        console.log(
          `Successfully created project ${id}. Now try \`cd ${root}\`, editing src/${id}/${id}.ts then \`yarn watch\`.`
        );
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
    execSync(
      // package.json might have a version increment, that's not commited yet (e.g. when using lerna)
      "git diff-index --ignore-submodules --quiet HEAD -- './:!package.json'"
    ).toString();
  } catch (e) {
    throw new Error(
      `There are uncommitted things. Commit them before running vup.`
    );
  }
  // first find a plugin file
  const globbedTs = globby.sync(["src/*/*.ts", "!src/@types"]);
  const pluginIds = getAllPluginIds(globbedTs);
  const anyPluginName = pluginIds[0];

  const parDir = `${options.outDir}/tmp`;
  try {
    await fs.readdir(parDir);
  } catch (e) {
    console.warn(
      `Expected temporary build plugin files in ${parDir}. Building first. We need these to read the .mjs plugins (can't read ts directly for now) and extract a current version.`
    );
    await build(options);
  }

  const oldVersion = (
    await evalPlugin(
      await fs.readFile(
        `./${TMP_DIR}/${anyPluginName}/${anyPluginName}.js`,
        "utf8"
      ),
      `./${TMP_DIR}/${anyPluginName}/`
    )
  ).version!;
  console.log(`latest version of ${anyPluginName}: ${oldVersion}`);
  const packageJsonVersion = JSON.parse(
    await fs.readFile("./package.json", "utf8")
  ).version;
  const newVersion = options.version || packageJsonVersion;
  console.log(`upping to: ${newVersion}`);
  // HACK: this is crude, and could f'up code that has "version: "..." in it"
  execSync(
    `sed -i 's/version: "${oldVersion}"/version: "${newVersion}"/g' src/*/*.ts`
  );
  await build({ ...options, prod: true });
  // remove the old plugins
  try {
    execSync(`rm dist/*.${oldVersion.replace(/\./g, "-")}.*.ls`);
  } catch (e) {
    console.warn("error removing old version's files");
  }
  // make an vup commit (version tagging is done by the parent repo -- which determines which commit actually gets into the extension's package)
  execSync("git add src dist");
  // no longer doing this in the mono repo
  // execSync(`git commit -m "Version upped from ${oldVersion} to ${newVersion}" -a`);
}

program.version(version);

program.parseAsync(process.argv).catch((e) => {
  console.error(e);
  process.exit(1);
});
