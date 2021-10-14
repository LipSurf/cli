#!/bin/sh
":"; //# comment; exec /usr/bin/env node --no-warnings --experimental-vm-modules "$0" "$@"
// #!/usr/bin/env node
import program from "commander";
import { fork } from "child_process";
import globby from "globby";
import path from "path";
import { transform } from "lodash";
import { getDotEnv, escapeQuotes } from "./util";
import fs from "fs-extra";
import { execSync } from "child_process";
import { evalPlugin } from "./evaluator";
import { transformJSToPlugin } from "./transform";
import { compile, watch } from "./ts-compile";
import { ChildProcess } from "node:child_process";
import { transformFile } from "@swc/core";
import chokidar from "chokidar";

const IS_PROD = process.env.NODE_ENV === "production";
const TMP_DIR = "dist/tmp";
const FOLDER_REGX = /^src\/(.*)\/([^.]*).*$/;

program
  .option("-p, --project", "ts config file path", "./tsconfig.json")
  .option("-o, --out-dir <destination>", "destination", "dist");

program
  .command("build [...PLUGINS]")
  .description("build lipsurf plugins")
  .option("-w, --watch")
  .option("-t, --check", "check types")
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
        .filter((regexRes) => regexRes && regexRes[1] === regexRes[2])
        .map((regexRes) => regexRes![1])
    )
  );
}

// Drops the first element of a tuple. Example:
//
//   type Foo = DropFirstInTuple<[string, number, boolean]>;
//   //=> [number, boolean]
//
type DropFirstInTuple<T extends any[]> = ((...args: T) => any) extends (
  arg: any,
  ...rest: infer U
) => any
  ? U
  : T;

function forkAndTransform(
  pluginIds: string[],
  ...args: DropFirstInTuple<Parameters<typeof transformJSToPlugin>>
): Promise<void> {
  return new Promise((cb) => {
    if (pluginIds.length === 1) {
      transformJSToPlugin(pluginIds[0], ...args).finally(cb);
    } else {
      let finishedForks = 0;
      const forks: ChildProcess[] = [];
      for (let pluginId of pluginIds) {
        // forking done as a workaround for bug in SWC:
        // https://github.com/swc-project/swc/issues/1366
        // (but hey, it probably also improves perf)
        const forked = fork(path.join(__dirname, "./worker.js"));
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
async function build(
  options: {
    baseImports: boolean;
    outDir: string;
    prod?: boolean;
    watch: boolean;
    check: boolean;
  },
  plugins = ""
) {
  const timeStart = new Date();
  let globbedTs: string[];
  let pluginIds;
  if (!plugins.length) {
    globbedTs = globby.sync(["src/**/*.ts", "!src/@types"]);
    pluginIds = getAllPluginIds(globbedTs);
  } else {
    pluginIds = (<string[]>[]).concat(plugins.split(","));
    globbedTs = globby.sync(pluginIds.map((p) => `src/${p}/*.ts`));
  }
  console.log("Building plugins:", pluginIds);

  let envVars: { [k: string]: string } = {};
  const isProd = !!(IS_PROD || options.prod);
  const baseImports =
    typeof options.baseImports !== "undefined" ? options.baseImports : true;
  const envFile = isProd ? ".env" : ".env.development";
  try {
    envVars = getDotEnv(path.join(envFile));
  } catch (e) {
    console.warn(`No "${envFile}" file found.`);
  }
  const define = transform(
    { NODE_ENV: isProd ? "production" : "development", ...envVars },
    (r: {}, val, key) => (r[`process.env.${key}`] = `"${escapeQuotes(val)}"`)
  );

  if (options.watch) {
    if (options.check) {
      watch(globbedTs, async () => {
        console.log("Starting transform...");
        await forkAndTransform(
          pluginIds,
          globbedTs,
          options.outDir,
          isProd,
          baseImports,
          define
        );
        console.log("Done transforming.");
      });
    } else {
      let queued = false;
      chokidar.watch("src").on("all", async (event, path) => {
        if (!queued) {
          queued = true;
          // just do all of them
          await transpileFiles(globbedTs);
          console.log("Starting transform...");
          await forkAndTransform(
            pluginIds,
            globbedTs,
            options.outDir,
            isProd,
            baseImports,
            define
          );
          console.log("Done transforming.");
          queued = false;
        }
      });
    }
  } else {
    if (options.check) await compile(globbedTs);
    else {
      await transpileFiles(globbedTs);
    }
    await forkAndTransform(
      pluginIds,
      globbedTs,
      options.outDir,
      isProd,
      baseImports,
      define
    );
    const timeEnd = new Date();
    console.log(
      `Done building in ${((+timeEnd! - +timeStart) / 1000).toFixed(
        2
      )} seconds.`
    );
  }
}

function transpileFiles(globbedTs: string[]) {
  return Promise.all(
    globbedTs.map((f) =>
      transformFile(f, {
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
        else dir = TMP_DIR;
        const outputF = `${dir}/${splitted[splitted.length - 2]}.js`;
        return fs.ensureDir(dir).then(() => fs.writeFile(outputF, t.code));
      })
    )
  );
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
  const versionSplit = oldVersion.split(".");
  const newVersion =
    options.version || `${versionSplit[0]}.${+versionSplit[1] + 1}.0`;
  console.log(`upping to: ${newVersion}`);
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

program.parseAsync(process.argv).catch((e) => {
  console.error(e);
  process.exit(1);
});
