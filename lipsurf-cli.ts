#!/usr/bin/env node
import * as program from "commander";
import globby from "globby";
import { PLANS } from "lipsurf-common/cjs/constants";
import { join } from "path";
import { promises as fs } from "fs";
import { execSync } from "child_process";
import { compile } from "./ts-compile";
// import ParsedPlugin from "./lib/ParsedPlugin";
import { make } from "./transform";
// (useful for turning off when importing plugins in LipSurf.js
import vm from "vm";

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

// class Linker {
//   resolver;

//   constructor(resolver, basedir) {
//     this.resolver = resolver;
//     this.basedir = basedir;
//   }
//   async link(specifier, referencingModule) {
//     try {
//       console.log(
//         "baseDir",
//         this.basedir,
//         "specifier",
//         specifier,
//         "referencing module",
//         referencingModule
//       );
//       // let filePath;
//       // if (specifier.startsWith(".")) {
//       //   filePath = `${specifier}.js`;
//       // } else {
//       //   filePath = `./node_modules/${specifier}`;
//       // }
//       const filePath = await new Promise((cb) =>
//         this.resolver(
//           specifier,
//           {
//             basedir: this.basedir,
//           },
//           (err, res) => cb(res)
//         )
//       );
//       console.log("filepath", filePath);
//       const file = await fs.readFile(filePath, "utf8");
//       console.log("context", referencingModule.context);
//       return new vm.SourceTextModule(file, {
//         context: referencingModule.context,
//       });
//     } catch (e) {
//       throw new Error(`Error linking ${specifier}`, e);
//     }
//     // Using `contextifiedObject` instead of `referencingModule.context`
//     // here would work as well.
//   }
// }

function resolvePlugin() {
  const resolve = require("resolve");
  // const linker = new Linker(
  //   resolve,
  //   pluginWLanguageFiles[0].substr(
  //     0,
  //     pluginWLanguageFiles[0].lastIndexOf("/")
  //   )
  // );
}

async function build(options, plugins) {
  if (typeof plugins === "undefined") plugins = [];
  let pluginNames = <string[]>[].concat(plugins);
  const watch = options.watch;
  const timeStart = new Date();
  const globbedTs = globby.sync(["src/*/*.ts", "!src/@types"]);
  if (!pluginNames.length) {
    pluginNames = Array.from(
      new Set(
        globbedTs
          .map((filePath) => FOLDER_REGX.exec(filePath))
          .filter((regxRes) => regxRes && regxRes[1] === regxRes[2])
          .map((regxRes) => regxRes![1])
      )
    );
  }
  console.log("Building plugins:", pluginNames);

  if (watch) {
  } else {
    await compile(globbedTs);
    for (const pluginName of pluginNames) {
      const pluginWLanguageFiles = globbedTs
        .map((f) => f.replace(/^src\//, "dist/tmp/").replace(/.ts$/, ".js"))
        .filter((x) => x.substr(x.lastIndexOf("/")).includes(`/${pluginName}.`))
        .sort((a, b) => a.length - b.length);
      const resolveDir = pluginWLanguageFiles[0].substr(
        0,
        pluginWLanguageFiles[0].lastIndexOf("/")
      );
      const codeParts = await Promise.all(
        pluginWLanguageFiles.map((f) => fs.readFile(f, { encoding: "utf8" }))
      );
      (
        await make(
          pluginName,
          codeParts[0],
          pluginWLanguageFiles.slice(1),
          resolveDir,
          options.baseImports
        )
      ).forEach((c, i) => {
        if (c)
          fs.writeFile(
            `${join(options.outDir, pluginName)}.4-0-0.${PLANS[i]}.ls`,
            c
          );
      });
      // make a temporary ts file that imports the other langs
      // (to avoid dupe names when just conjoining the plugins)

      // console.log("transformed", transformed);
      // const codeParts = await Promise.all(
      //   pluginWLanguageFiles.map((f) => fs.readFile(f, { encoding: "utf8" }))
      // );
      // const codeParts = [
      //   // ...pluginWLanguageFiles.map((x, i) => {
      //   //   const name = x.substring(x.lastIndexOf("/") + 1, x.length - 3);
      //   //   return i === 0
      //   //     ? `import plugin from "./${name}";`
      //   //     : `import "./${name}";`;
      //   // }),
      //   // `export default plugin;`,
      //   await fs.readFile(pluginWLanguageFiles[0], "utf8"),
      // ];

      // const context = {
      //   // this: {},
      //   global: {},
      //   exports: {},
      //   module: {
      //     exports: {},
      //   },
      //   PluginBase: {
      //     languages: {},
      //   },
      // };
      // vm.createContext(context);
      // const finalScript = codeParts.join("\n");
      // console.log("codeParts", finalScript);
      // const mod = new vm.SourceTextModule(finalScript, { context });
      // try {
      //   await mod.link(linker.link.bind(linker));
      // } catch (e) {
      //   console.error(`linking error`, e);
      // }
      // await mod.evaluate();
      // debugger;
      // console.log("mod", mod, "context", context, "namespace", mod.namespace);

      // console.log("TRANSFOOOORMEDDD");
      // transform.make(mod.namespace.default);
      // console.log(mod.namespace.default.commands[0].pageFn.toString());

      // console.log("-----------------");
      // console.log(mod.namespace.default.toString());

      // console.log(context);
      // console.log("mod", mod, "context", context, "namespace", mod.namespace);

      // console.log("freePlugin", freePlugin);
    }
    const timeEnd = new Date();
    console.log(
      `Done building in ${Math.round((+timeEnd - +timeStart) / 1000)} seconds.`
    );
  }
}

async function upVersion(options) {
  // // make sure there are no unexpected changes so that we don't include them in the upversion commit
  // try {
  //   execSync(
  //     "git diff-index --ignore-submodules --quiet HEAD -- ./"
  //   ).toString();
  // } catch (e) {
  //   throw new Error(
  //     `There are uncommitted things. Commit them before running vup.`
  //   );
  // }
  // // first find a plugin file
  // const parDir = `${options.outDir}/tmp`;
  // let files;
  // try {
  //   files = await fs.readdir(parDir);
  // } catch (e) {
  //   console.warn(
  //     `Expected temporary build plugin files in ${parDir}. Running \`yarn build\` first. We need these to read the .mjs plugins (can't read ts directly for now) and extract a current version.`
  //   );
  //   execSync("yarn build");
  //   files = await fs.readdir(parDir);
  // }
  // const allPluginNames = files.filter(
  //   (x) => !x.startsWith(".") || x.endsWith(".mjs"),
  //   {}
  // );
  // const anyPluginName = allPluginNames[0];
  // const source = await fs
  //   .readFile(`${parDir}/${anyPluginName}.joined.mjs`)
  //   .toString();
  // const parsed = new ParsedPlugin(jscodeshift, source);
  // const oldVersion = parsed.getVersion();
  // console.log(`latest version of ${anyPluginName}: ${oldVersion}`);
  // const versionSplit = oldVersion.split(".");
  // const newVersion =
  //   options.version || `${versionSplit[0]}.${+versionSplit[1] + 1}.0`;
  // console.log(`upping to: ${newVersion}`);
  // execSync(
  //   `sed -i 's/version: "${oldVersion}"/version: "${newVersion}"/g' src/*/*.ts`
  // );
  // await build({ outDir: options.outDir, prod: true });
  // // remove the old plugins
  // try {
  //   execSync(`rm dist/*.${oldVersion.replace(/\./g, "-")}.*.ls`);
  // } catch (e) {
  //   console.warn("error removing old version's files");
  // }
  // // make an vup commit (version tagging is done by the parent repo -- which determines which commit actually gets into the extension's package)
  // execSync("git add src dist");
  // // no longer doing this in the mono repo
  // // execSync(`git commit -m "Version upped from ${oldVersion} to ${newVersion}" -a`);
}

program.parseAsync(process.argv).catch((e) => {
  console.error(e);
  process.exit(1);
});
