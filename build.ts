import fs from "fs-extra";
import transform from "lodash/transform";
import { getDotEnv, escapeQuotes } from "./util";
import { compile, watch } from "./ts-compile";
import chokidar from "chokidar";
import globby from "globby";
import { transformJSToPlugin } from "./transform";
import { ChildProcess } from "node:child_process";
import { transformFile } from "@swc/core";
import path from "path";
import { fork } from "child_process";
import { timedErr, timedLog } from "./log";

export const TMP_DIR = "dist/tmp";
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
export async function build(
  options: {
    outDir: string;
    baseImports?: boolean;
    prod?: boolean;
    watch?: boolean;
    check?: boolean;
  },
  plugins: string[] = []
) {
  const timeStart = new Date();
  let globbedTs: string[];
  let pluginIds;
  if (!plugins.length) {
    globbedTs = globby.sync(["src/**/*.ts", "!src/@types"]);
    pluginIds = getAllPluginIds(globbedTs);
  } else if (plugins[0].endsWith(".ts")) {
    // specific files
    globbedTs = plugins;
    pluginIds = plugins.map((p) =>
      p.substring(p.lastIndexOf("/") + 1, p.length - 3)
    );
  } else {
    // plugin ids
    globbedTs = globby.sync([
      ...plugins.map((id) => `src/${id}/*.ts`),
      "!src/@types",
    ]);
    pluginIds = plugins;
  }
  timedLog("Building plugins:", pluginIds);

  if (globbedTs.length === 0) {
    throw new Error(
      "No plugins found. Pass a [PLUGIN_PATH] or put plugins in src/[plugin name]/[plugin name].ts"
    );
  }

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
        timedLog("Starting transform...");
        await forkAndTransform(
          pluginIds,
          globbedTs,
          options.outDir,
          isProd,
          baseImports,
          define
        );
        timedLog("Done transforming.");
      });
    } else {
      let queued = false;
      chokidar.watch(globbedTs).on("all", async (event, path) => {
        if (!queued) {
          queued = true;
          // just do all of them
          await transpileFiles(globbedTs);
          timedLog("Starting transform...");
          await forkAndTransform(
            pluginIds,
            globbedTs,
            options.outDir,
            isProd,
            baseImports,
            define
          );
          timedLog("Done transforming.");
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
    timedLog(
      `Done building in ${((+timeEnd! - +timeStart) / 1000).toFixed(
        2
      )} seconds.`
    );
  }
}

export function getAllPluginIds(files: string[]) {
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
        const forked = fork(path.join(__dirname, "./worker.js"), {
          env: {
            NODE_NO_WARNINGS: "1",
            NODE_OPTIONS: "--experimental-vm-modules",
            ...process.env,
          },
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
