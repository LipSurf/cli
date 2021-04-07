#!/bin/sh
":"; //# comment; exec /usr/bin/env node --experimental-vm-modules "$0" "$@"
"use strict";
// #!/usr/bin/env node
import program from "commander";
import globby from "globby";
import { PLANS } from "lipsurf-common/cjs/constants";
import { join } from "path";
import { promises as fs } from "fs";
import { execSync } from "child_process";
import { evalPlugin } from "./evaluator";
import { compile } from "./ts-compile";
import { makePlugin } from "./transform";

const FOLDER_REGX = /^src\/(.*)\/([^.]*).*$/;

program
  .option("-p, --project", "ts config file path", "./tsconfig.json")
  .option("-o, --out-dir <destination>", "destination", "dist");

program
  .command("build [...PLUGINS]")
  .description("build lipsurf plugins")
  .option("-w, --watch")
  .option("--no-base-imports")
  .action((plugins, cmdObj) => build({ ...cmdObj, ...cmdObj.parent }, plugins));

program
  .command("vup")
  .description("up the minor version of all the plugins")
  .option(
    "-v, --version <version>",
    "specify a version instead of incrementing the minor version by 1"
  )
  .action((cmdObj) => upVersion({ ...cmdObj, ...cmdObj.parent }));

function getAllPluginIds(files: string[]) {
  return Array.from(
    new Set(
      files
        .map((filePath) => FOLDER_REGX.exec(filePath))
        .filter((regxRes) => regxRes && regxRes[1] === regxRes[2])
        .map((regxRes) => regxRes![1])
    )
  );
}

function versionConvertDots(v) {
  return v.replace(/\./g, "-");
}

async function build(options, plugins?) {
  if (typeof plugins === "undefined") plugins = [];
  let pluginIds = <string[]>[].concat(plugins);
  const watch = options.watch;
  const timeStart = new Date();
  const globbedTs = globby.sync(["src/*/*.ts", "!src/@types"]);
  if (!pluginIds.length) {
    pluginIds = getAllPluginIds(globbedTs);
  }
  console.log("Building plugins:", pluginIds);

  if (watch) {
  } else {
    const p: Promise<void>[] = [];
    await compile(globbedTs);
    for (const pluginId of pluginIds) {
      const pluginWLanguageFiles = globbedTs
        .map((f) => f.replace(/^src\//, "dist/tmp/").replace(/.ts$/, ".js"))
        .filter((x) => x.substr(x.lastIndexOf("/")).includes(`/${pluginId}.`))
        .sort((a, b) => a.length - b.length);
      const resolveDir = pluginWLanguageFiles[0].substr(
        0,
        pluginWLanguageFiles[0].lastIndexOf("/")
      );
      p.push(
        makePlugin(
          pluginId,
          pluginWLanguageFiles,
          resolveDir,
          process.env.NODE_ENV === "production"
        )
          .then((res) => {
            const version = versionConvertDots(res[1]);
            res[0].forEach((c, i) => {
              if (c)
                fs.writeFile(
                  `${join(options.outDir, pluginId)}.${version}.${PLANS[i]}.ls`,
                  c,
                  "utf8"
                );
            });
          })
          .catch((e) => {
            console.error(`Error making ${pluginId}: ${e}`);
          })
      );
    }
    await Promise.all(p);
    const timeEnd = new Date();
    console.log(
      `Done building in ${Math.round((+timeEnd - +timeStart) / 1000)} seconds.`
    );
  }
}

async function upVersion(options) {
  // make sure there are no unexpected changes so that we don't include them in the upversion commit
  try {
    execSync(
      "git diff-index --ignore-submodules --quiet HEAD -- ./"
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
  let files;
  try {
    files = await fs.readdir(parDir);
  } catch (e) {
    console.warn(
      `Expected temporary build plugin files in ${parDir}. Building first. We need these to read the .mjs plugins (can't read ts directly for now) and extract a current version.`
    );
    await build(options);
    files = await fs.readdir(parDir);
  }

  const oldVersion = (
    await evalPlugin(
      await fs.readFile(
        `./dist/tmp/${anyPluginName}}/${anyPluginName}.js`,
        "utf8"
      ),
      `./dist/tmp/${anyPluginName}/`
    )
  ).version!;
  console.log(`latest version of ${anyPluginName}: ${oldVersion}`);
  const versionSplit = oldVersion.split(".");
  const newVersion =
    options.version || `${versionSplit[0]}.${+versionSplit[1] + 1}.0`;
  console.log(`upping to: ${newVersion}`);
  execSync(
    `sed -i 's/version: "${oldVersion}"/version: "${newVersion}"/g' src/*/*.ts`
  );
  await build(options);
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

program.parseAsync(process.argv).catch((e) => {
  console.error(e);
  process.exit(1);
});
