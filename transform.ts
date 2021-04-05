/**
 * Split the plugin into a frontend/backend and a matching/non-matching URL for
 * frontend. Frontend needs to be loaded on every page, so it should be lightweight.
 *
 * We don't operate on the eval'd plugin js because (eg. with the node VM module)
 * because there seems to be no straightforward way to reserialize the resulting
 * object that we create?
 *
 * (eg. Plugin.languages.ru = ..., later Plugin.languages.ru.commands = (morphed))
 * we don't operate solely on eval'd js, because it wouldn't allow certain things
 * like abstracting away PluginBase with {...PluginBase, { ...(plugin code)}}
 *
 * For frontend:
 *    * remove homophones
 *    * remove commands.match,description,fn,test,delay,nice,context,enterContext,plan
 *    * replace non-default exports
 *    * TODO: remove commands that have no pageFn or dynamic match
 * Backend:
 *    * no need to make more space-efficient because the store watchers/mutators
 *      only take what they need.
 */
/// <reference types="lipsurf-types/extension"/>
import resolve from "resolve";
import { readFile } from "fs/promises";
import { build, transform, transformSync } from "esbuild";
import vm from "vm";
import { PluginPartType } from "./util";
import {
  PLANS,
  PLUGIN_SPLIT_SEQ,
  EXT_ID,
  FREE_PLAN,
  PLUS_PLAN,
  PREMIUM_PLAN,
} from "lipsurf-common/cjs/constants";
import {
  ExportDefaultExpression,
  KeyValueProperty,
  ModuleDeclaration,
  parseSync,
} from "@swc/core";
import {
  Property,
  SpreadElement,
  ObjectExpression,
  ArrayExpression,
  NumericLiteral,
} from "@swc/core";
import Visitor from "@swc/core/Visitor";
import { ExpressionStatement } from "typescript";
const PLUGIN_PROPS_TO_REMOVE_FROM_CS = [
  "description",
  "homophones",
  "version",
  "authors",
  "icon",
  "match",
  "plan",
  "apiVersion",
  "contexts",
  "niceName",
  "replacements",
  "settings",
];

const COMMAND_PROPS_TO_REMOVE_FROM_CS = [
  "fn",
  "delay",
  "description",
  "test",
  "global",
  "normal",
  "context",
  "onlyFinal",
  "minConfidence",
  "enterContext",
  "activeDocument",
];

const importPluginBase = `import PluginBase from 'chrome-extension://${EXT_ID}/dist/modules/plugin-base.js';`;
const importExtensionUtil = `import ExtensionUtil from 'chrome-extension://${EXT_ID}/dist/modules/extension-util.js';`;

function versionConvertDots(v) {
  return v.replace(/\./g, "-");
}

// SpreadElement doesn't have generic
interface WrappedExpression<T> {
  spread: null;
  expression: T;
}

class BlankPartError extends Error {}

class PluginExportReplacer extends Visitor {
  constructor(private pluginStr: string) {
    super();
  }

  visitExportDefaultExpression(n: ExportDefaultExpression): ModuleDeclaration {
    if (n.expression.type === "ObjectExpression") {
      const pluginObjectExp = <KeyValueProperty>(
        n.expression.properties.find((p) => p.type === "KeyValueProperty")
      );
      debugger;
      if (pluginObjectExp) {
        // @ts-ignore
        pluginObjectExp.value = parseSync(this.pluginStr);
      }
    }
    return n;
  }
}

class Linker {
  constructor(private resolver, private basedir: string) {}

  async link(specifier, referencingModule) {
    try {
      console.log(
        "baseDir",
        this.basedir,
        "specifier",
        specifier,
        "referencing module",
        referencingModule
      );
      // let filePath;
      // if (specifier.startsWith(".")) {
      //   filePath = `${specifier}.js`;
      // } else {
      //   filePath = `./node_modules/${specifier}`;
      // }
      const filePath = await new Promise<string>((cb) =>
        this.resolver(
          specifier,
          {
            basedir: this.basedir,
          },
          (err, res) => cb(res)
        )
      );
      console.log("filepath", filePath);
      const file = await readFile(filePath, "utf8");
      // @ts-ignore
      return new vm.SourceTextModule(file, {
        context: referencingModule.context,
      });
    } catch (e) {
      throw new Error(`Error linking ${specifier}\n${e}`);
    }
    // Using `contextifiedObject` instead of `referencingModule.context`
    // here would work as well.
  }
}

function makeCS(plugin: IPlugin, plan: plan, type: PluginPartType) {
  for (const prop of PLUGIN_PROPS_TO_REMOVE_FROM_CS) {
    delete plugin[prop];
  }
  for (let i = plugin.commands.length - 1; i >= 0; i--) {
    const cmd = plugin.commands[i];
    for (const prop of COMMAND_PROPS_TO_REMOVE_FROM_CS) {
      delete cmd[prop];
    }
    // merge localized match fns into the plugin.commands.match object
    if (cmd.match === Object(cmd.match)) {
      const oldMatch = cmd.match;
      // @ts-ignore
      cmd.match = Object.keys(plugin.languages || []).reduce(
        (memo, lang) => {
          const localizedFn = plugin.languages![lang]?.commands[cmd.name]?.match
            .fn;
          if (localizedFn) memo[lang] = localizedFn;
          return memo;
        },
        { en: oldMatch }
      );
    } else {
      // @ts-ignore
      delete cmd.match;
    }
    // only the name key
    if (Object.keys(cmd).length === 1) plugin.commands.splice(i, 1);
  }
  delete plugin.languages;
  return plugin;
}

// https://codereview.stackexchange.com/questions/179471/find-the-corresponding-closing-parenthesis
function findClosingBrace(str: string, startPos) {
  const rExp = /\{|\}/g;
  rExp.lastIndex = startPos + 1;
  var deep = 1;
  while ((startPos = rExp.exec(str))) {
    if (!(deep += str[startPos.index] === "{" ? 1 : -1)) {
      return startPos.index;
    }
  }
}

export async function makePlugin(
  pluginId: string,
  pluginWLanguageFiles: string[],
  resolveDir: string,
  prod = false,
  baseImports = true
): Promise<PluginSub> {
  const importPluginDepsCode = [
    ...pluginWLanguageFiles.map((x, i) => {
      const name = x.substring(x.lastIndexOf("/") + 1, x.length - 3);
      return i === 0
        ? `import plugin from "./${name}";`
        : `import "./${name}";`;
    }),
    `export default plugin;`,
  ].join("\n");

  // bundle the deps
  console.time("bundle");
  const resolvedPluginCode = (
    await build({
      stdin: {
        contents: importPluginDepsCode,
        sourcefile: `dumby.js`,
        resolveDir,
        loader: "js",
      },
      format: "esm",
      write: false,
      bundle: true,
    })
  ).outputFiles[0].text;
  console.timeEnd("bundle");

  const byPlanAndMatching = {
    [FREE_PLAN]: {},
    [PLUS_PLAN]: {},
    [PREMIUM_PLAN]: {},
  };
  console.time("find");
  const searchQ = `var ${pluginId}_default = {`;
  const pluginSrcReplacementStartI =
    resolvedPluginCode.search(new RegExp(searchQ)) + searchQ.length;
  const pluginSrcReplacementEndI = findClosingBrace(
    resolvedPluginCode,
    pluginSrcReplacementStartI
  );
  console.timeEnd("find");

  // console.log("start", pluginSrcReplacementStartI, pluginSrcReplacementEndI);
  // console.log(
  //   resolvedPluginCode.substring(
  //     pluginSrcReplacementStartI,
  //     pluginSrcReplacementEndI
  //   )
  // );

  let i = 0;
  console.time("eval");
  let parsedPluginObj = await evalPlugin(resolvedPluginCode, resolveDir);
  console.timeEnd("eval");
  console.time("makeParts");
  const cloneStr = JSON.stringify(parsedPluginObj);
  for (const plan of PLANS) {
    let type: PluginPartType;
    for (type of Object.values<PluginPartType>(
      <any>PluginPartType
    ).filter((x) => isNaN(Number(x)))) {
      let code: string;
      try {
        code = `${resolvedPluginCode.substr(
          0,
          pluginSrcReplacementStartI
        )}...PluginBase, ...${uneval(
          makeCS(parsedPluginObj, plan, type)
        )}${resolvedPluginCode.substr(pluginSrcReplacementEndI)}`;
      } catch (e) {
        if (e instanceof BlankPartError) code = "";
        else throw new Error(`Error transforming ${pluginId}.${plan} ${e}`);
      }
      byPlanAndMatching[plan][type] = code;
      // work with copies
      if (i != 5) {
        i++;
        parsedPluginObj = JSON.parse(cloneStr);
      }
    }
  }
  console.timeEnd("makeParts");

  const transformedPluginsTuple = [
    resolvedPluginCode,
    ...PLANS.reduce(
      (memo, p) =>
        memo.concat([
          byPlanAndMatching[p]["matching"],
          byPlanAndMatching[p]["nonmatching"],
        ]),
      []
    ),
  ];
  // console.log("after transform:\n", transformedPluginsTuple[1]);
  // console.log("after transform (nonmatching):\n", transformedPluginsTuple[2]);

  // Only for minifying and treeshaking
  console.time("minify and treeshake");
  const splitPluginTuple = (
    await Promise.all(
      transformedPluginsTuple.map((code) =>
        build({
          // entryPoints: ,
          // outdir: options.outDir,
          stdin: {
            contents: code,
            sourcefile: `${pluginId}.js`,
            resolveDir,
            loader: "js",
          },
          write: false,
          bundle: true,
          // for iife
          // globalName: `allPlugins.${pluginId}`,
          minify: prod,
          format: "esm",
          minifyWhitespace: prod,
          minifySyntax: true,
          // defaults to esNext (we build to the target with tsc)
          // target: "es2019",
        })
      )
    )
  ).map((f) => f.outputFiles[0].text);
  console.timeEnd("minify and treeshake");

  // console.log(splitPluginTuple[0]);

  // console.log("after transform:");
  let baseImportsStr = "";
  if (baseImports) {
    baseImportsStr = importPluginBase + importExtensionUtil;
  }

  const finalPluginsTuple: Partial<PluginSub> = [];
  // combine the files into .ls file
  for (let i = 0; i < PLANS.length; i++) {
    const matchingNonMatching = splitPluginTuple.slice(
      i * 2 + 1,
      (1 + i) * 2 + 1
    );
    if (
      PLANS[i] !== FREE_PLAN &&
      matchingNonMatching.reduce((memo, x) => memo + x.length, 0) === 0
    )
      // no plugin for this level
      finalPluginsTuple.push("");
    else
      finalPluginsTuple.push(
        [
          baseImportsStr + splitPluginTuple[0],
          ...matchingNonMatching.map(
            (s) =>
              `allPlugins.${pluginId} = (() => { ${s.replace(
                `export default require_${pluginId}()`,
                `return require_${pluginId}().default`
              )} })();`
          ),
        ].join(PLUGIN_SPLIT_SEQ)
      );
  }

  return <PluginSub>finalPluginsTuple;
}

function uneval(l: any): string {
  debugger;
  switch (true) {
    // case l instanceof Function: // (does not work for async functions)
    case typeof l === "function":
      return l.toString();
    case l instanceof RegExp:
      return `new RegExp("${l.source}", "${l.flags}")`;
    case Array.isArray(l):
      return `[${l.map((item) => uneval(item)).join(",")}]`;
    case l === Object(l):
      return `{${Object.keys(l)
        .map((k) => `"${k}": ${uneval(l[k])}`)
        .join(",")}}`;
    // instanceof String doesn't work
    case typeof l === "string":
      return `"${l.replace(/"/g, '\\"')}"`;
    default:
      return l;
  }
}

async function evalPlugin(code: string, resolveDir: string): Promise<IPlugin> {
  const context = {
    // this: {},
    global: {},
    exports: {},
    module: {
      exports: {},
    },
    PluginBase: {
      languages: {},
    },
  };
  const linker = new Linker(resolve, resolveDir);
  vm.createContext(context);
  if (!("SourceTextModule" in vm))
    throw new Error("Must run node with --experimental-vm-modules");
  // @ts-ignore
  const mod = new vm.SourceTextModule(code, { context });
  let linked;
  try {
    linked = await mod.link(linker.link.bind(linker));
  } catch (e) {
    console.error(`linking error`, e);
  }
  debugger;
  await mod.evaluate();
  // console.log("default", mod.namespace.default);
  return mod.namespace.default;
}
