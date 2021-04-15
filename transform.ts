/*;
 * Split the plugin into a frontend/backend and a matching/non-matching URL for
 * frontend. Frontend needs to be loaded on every page, so it should be lightweight.
 *
 * We operate on the eval'd plugin js because (with the node VM module)
 * because manipulating the js object is much more straightforward, less tedious
 * and less error prone.
 *
 * Using a parser like SWC is tedious and error prone because depending on the format
 * of the output, many cases would need to be handled. E.g. consider the various ways
 * that the various syntax that can be used to export the default module:
 *
 * export default Plugin;
 * export {
 *   Plugin as default
 * }
 * export default { ... }
 *
 *
 * For frontend:
 *    * remove homophones, contexts, settings and other props only needed on the backend
 *    * remove command properties such as match, description, fn, test, delay etc.
 *    * replace non-default exports
 *    * TODO: remove commands that have no pageFn or dynamic match
 * Backend:
 *    * no need to make more space-efficient because the store watchers/mutators
 *      only take what they need.
 */
/// <reference types="lipsurf-types/extension"/>
import { build } from "esbuild";
import { PluginPartType } from "./util";
import { evalPlugin } from "./evaluator";
import { keyBy, mapValues, omit } from "lodash";
import { join } from "path";
import { promises as fs } from "fs";
import { escapeQuotes } from "lipsurf-common/cjs/dev";
import {
  Expression,
  Compiler,
  Swcrc,
  StringLiteral,
  ExpressionStatement,
  CallExpression,
  Module,
  Script,
  printSync,
  transformSync,
  parse,
  ModuleItem,
  Span,
  parseSync,
} from "@swc/core";
import Visitor from "@swc/core/Visitor";
import clone from "clone";
import {
  PLANS,
  PLUGIN_SPLIT_SEQ,
  EXT_ID,
  FREE_PLAN,
  PLUS_PLAN,
  PREMIUM_PLAN,
} from "lipsurf-common/cjs/constants";
const REPLACED_FN_SYMBOL = "@@";
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

const PLUGIN_BASE_PROPS = [
  "annotations",
  "util",
  "help",
  "constants",
  "languages",
];

const importPluginBase = `import PluginBase from 'chrome-extension://${EXT_ID}/dist/modules/plugin-base.js';`;
const importExtensionUtil = `import ExtensionUtil from 'chrome-extension://${EXT_ID}/dist/modules/extension-util.js';`;

class BlankPartError extends Error {}

function replaceCmdsAbovePlan(plugin: IPlugin, buildForPlan: plan): IPlugin {
  let cmdsOnThisPlan: boolean = false;
  const pluginPlan = plugin.plan || 0;
  // if nothing is replaced, and the highestLevel is lower than build for plan, then return false so we
  // don't build for this level (the highest level might have been 10 or 0, and already built)
  plugin.commands = plugin.commands.map((cmd) => {
    const cmdPlan = cmd.plan;
    const minNeededPlan = cmdPlan ? cmdPlan : pluginPlan;
    let replace = false;
    if (!cmdPlan) {
      if (pluginPlan === buildForPlan) cmdsOnThisPlan = true;
      else if (pluginPlan > buildForPlan) replace = true;
    } else {
      if (buildForPlan === cmdPlan) cmdsOnThisPlan = true;
      if (minNeededPlan > buildForPlan) replace = true;
    }
    if (replace) {
      // @ts-ignore
      cmd.pageFn = new Function(
        `showNeedsUpgradeError({plan: ${minNeededPlan}})`
      );
    }
    return cmd;
  });
  if (!cmdsOnThisPlan && buildForPlan !== 0) throw new BlankPartError();
  return plugin;
}

function makeCS(plugin: IPlugin, plan: plan, type: PluginPartType) {
  // must happen before we remove COMMAND_PROPS_TO_REMOVE_FROM_CS and PLUGIN_PROPS_TO_REMOVE_FROM_CS
  // since both have plan property
  plugin = replaceCmdsAbovePlan(plugin, plan);

  for (const prop of PLUGIN_PROPS_TO_REMOVE_FROM_CS) {
    delete plugin[prop];
  }

  for (let i = plugin.commands.length - 1; i >= 0; i--) {
    const cmd = plugin.commands[i];
    if (type === PluginPartType.nonmatching && !cmd.global) {
      plugin.commands.splice(i, 1);
      continue;
    }
    for (const prop of COMMAND_PROPS_TO_REMOVE_FROM_CS) {
      delete cmd[prop];
    }
    if (Array.isArray(cmd.match) || typeof cmd.match === "string") {
      // @ts-ignore
      delete cmd.match;
    } else {
      // merge localized match fns into the plugin.commands.match object
      const oldMatch = cmd.match;
      // @ts-ignore
      cmd.match = Object.keys(plugin.languages || []).reduce(
        (memo, lang) => {
          const localizedFn = plugin.languages![lang]?.commands[cmd.name]?.match
            .fn;
          if (localizedFn) memo[lang] = localizedFn;
          return memo;
        },
        { en: oldMatch.fn }
      );
    }
    if (typeof cmd.nice !== "function") {
      delete cmd.nice;
    }
    // only the name key
    if (Object.keys(cmd).length === 1) plugin.commands.splice(i, 1);
  }
  if (!plugin.commands.length && !plugin.init && !plugin.destroy)
    throw new BlankPartError();

  // array to obj
  plugin.commands = mapValues(keyBy(plugin.commands, "name"), (v) =>
    omit(v, "name")
  );

  // remove plugin-base props
  for (const prop of PLUGIN_BASE_PROPS) {
    delete plugin[prop];
  }
  return plugin;
}

function replaceSpans(
  code: string,
  spans: Span[],
  replacer?: (s: string) => string
) {
  const codeParts: string[] = [];
  let prevEnd = 0;
  let i = 0;
  for (; i < spans.length; i++) {
    const curSpan = spans[i];
    // console.log("replacing span", code.substring(spans[i].start, spans[i].end));
    codeParts.push(code.substring(prevEnd, curSpan.start));
    if (replacer) {
      codeParts.push(replacer(code.substring(curSpan.start, curSpan.end)));
    }
    prevEnd = curSpan.end;
  }
  codeParts.push(code.substring(prevEnd));
  return codeParts.join("");
}

function getLanguageDefSpans(pluginId: string, body: ModuleItem[]): Span[] {
  return body
    .filter(
      (x) =>
        x.type === "ExpressionStatement" &&
        x.expression &&
        x.expression.type === "AssignmentExpression" &&
        x.expression.left &&
        x.expression.left.type === "MemberExpression" &&
        x.expression.left.object.type === "MemberExpression" &&
        x.expression.left.object.object.type === "Identifier" &&
        x.expression.left.object.object.value === `${pluginId}_default` &&
        x.expression.left.property.type === "Identifier" &&
        x.expression.left.property.value.length === 2
    )
    .map((x) => x.span);
}

/**
 * Currently broken?
 *
 * https://github.com/swc-project/swc/discussions/1563
 *
 *  visitModule(m: Module): Module {
 *  m.body = this.visitModuleItems(m.body);
 *  return m;
 *}
 */
class FnReplacer extends Visitor {
  public callExpressionSpans: Span[] = [];
  constructor() {
    super();
  }

  visitCallExpression(c: CallExpression) {
    this.callExpressionSpans.push(c.span);
    return c;
  }
}

function getPluginSpan(pluginId: string, body: ModuleItem[]): Span {
  return body.find(
    (x) =>
      x.type === "VariableDeclaration" &&
      x.declarations[0].type === "VariableDeclarator" &&
      x.declarations[0].id.type === "Identifier" &&
      x.declarations[0].id.value === `${pluginId}_default` &&
      x.declarations[0].init &&
      x.declarations[0].init.type == "ObjectExpression"
    // @ts-ignore
  )!.declarations[0].init.span;
}

function versionConvertDots(v) {
  return v.replace(/\./g, "-");
}

export function transformJSToPlugin(
  pluginId: string,
  globbedTs: string[],
  outdir: string,
  baseImports: boolean,
  define: {}
) {
  const pluginWLanguageFiles = globbedTs
    .map((f) => f.replace(/^src\//, "dist/tmp/").replace(/.ts$/, ".js"))
    .filter((x) => x.substr(x.lastIndexOf("/")).includes(`/${pluginId}.`))
    .sort((a, b) => a.length - b.length);
  const resolveDir = pluginWLanguageFiles[0].substr(
    0,
    pluginWLanguageFiles[0].lastIndexOf("/")
  );
  return makePlugin(
    pluginId,
    pluginWLanguageFiles,
    resolveDir,
    process.env.NODE_ENV === "production",
    baseImports,
    define
  )
    .then((res) => {
      const version = versionConvertDots(res[1]);
      return Promise.all(
        res[0]
          .filter((c) => c)
          .map((c, i) =>
            fs.writeFile(
              `${join(outdir, pluginId)}.${version}.${PLANS[i]}.ls`,
              c,
              "utf8"
            )
          )
      );
    })
    .catch((e) => {
      console.error(`Error building ${pluginId}: ${e}`);
      throw e;
    });
}

async function makePlugin(
  pluginId: string,
  pluginWLanguageFiles: string[],
  resolveDir: string,
  prod = false,
  baseImports = true,
  define = {}
): Promise<[pluginForSub: PluginSub, version: string]> {
  let buildRes;
  try {
    const importPluginDepsCode = [
      ...pluginWLanguageFiles.map((x, i) => {
        const name = x.substring(x.lastIndexOf("/") + 1, x.length - 3);
        return i === 0
          ? `import plugin from "./${name}";`
          : `import "./${name}";`;
      }),
      `export default plugin;`,
    ].join("\n");
    const dumbySrcName = `dumby`;

    // bundle the deps
    buildRes = await build({
      stdin: {
        contents: importPluginDepsCode,
        sourcefile: `${dumbySrcName}.js`,
        resolveDir,
        loader: "js",
      },
      // charset: "utf8",
      format: "esm",
      write: false,
      bundle: true,
      incremental: true,
      define,
    });
    const resolvedPluginCode = <string>buildRes.outputFiles[0].text
      .replace("...PluginBase", "...PluginBase, ...{languages: {}}")
      // needed because ES build does not escape unicode characters in regex literals
      .replace(/[^\x00-\x7F]/g, (x) => `\\u${escape(x).substr(2)}`);

    const byPlanAndMatching = {
      [FREE_PLAN]: {},
      [PLUS_PLAN]: {},
      [PREMIUM_PLAN]: {},
    };
    const ast = await parse(resolvedPluginCode, {
      syntax: "ecmascript",
      dynamicImport: true,
    });

    const {
      start: pluginSrcReplacementStartI,
      end: pluginSrcReplacementEndI,
    } = getPluginSpan(pluginId, ast.body);

    // assume languages come after plugin definition (otherwise pluginSrcReplacementStartI would need to be adjusted)
    const languageObjsRemovedCode = replaceSpans(
      resolvedPluginCode,
      getLanguageDefSpans(pluginId, ast.body)
    );

    const noFnCallsCode = resolvedPluginCode;
    // currently broken because of missing call expressions
    // console.time("escape fn calls");
    // debugger;
    // const fnReplacer = new FnReplacer();
    // fnReplacer.visitProgram(ast);
    // const noFnCallsCode = replaceSpans(
    //   resolvedPluginCode,
    //   fnReplacer.callExpressionSpans,
    //   (code) => `"${escapeQuotes(code)}"`
    // );
    // console.log(noFnCallsCode);
    // console.timeEnd("escape fn calls");
    // throw "done";

    let i = 0;
    let parsedPluginObj: IPlugin;
    try {
      parsedPluginObj = await evalPlugin(noFnCallsCode);
    } catch (e) {
      throw new Error(`Error evaluating ${e}`);
    }
    const version = parsedPluginObj.version || "1.0.0";
    const exportRegx = new RegExp(
      `var\\s*${dumbySrcName}_default\\s*=\\s*${pluginId}_default;\\s*export\\s+{\\s*${dumbySrcName}_default\\s+as\\s+default\\s*};?`
    );

    let cloned = clone(parsedPluginObj, false);
    for (const plan of PLANS) {
      let type: PluginPartType;
      for (type of Object.values<PluginPartType>(<any>PluginPartType).filter(
        (x) => !isNaN(Number(x))
      )) {
        let code: string;
        try {
          code = `${languageObjsRemovedCode.substr(
            0,
            pluginSrcReplacementStartI
          )}{...PluginBase, ...${uneval(
            makeCS(cloned, plan, type)
          )}}${languageObjsRemovedCode.substr(pluginSrcReplacementEndI)}`;
        } catch (e) {
          if (e instanceof BlankPartError) code = "";
          else throw new Error(`Error transforming ${pluginId}.${plan} ${e}`);
        }
        /**
         * Might look like this for production build:
         * var t = { ... },
         * l = t;
         * export {
         *  l as
         *  default
         */
        if (code && !exportRegx.test(code)) {
          throw new Error(`Could not find the export regx in code.`);
        }
        byPlanAndMatching[plan][type] = code
          ? `allPlugins.${pluginId} = (() => { ${code
              .replace(`var ${pluginId}_default =`, "return")
              .replace(exportRegx, "")} })();`
          : "";
        // work with copies
        // don't need to make an extra copy at the end (small perf improvement)
        if (i != 5) {
          i++;
          cloned = clone(parsedPluginObj, false);
        } else {
          cloned = parsedPluginObj;
        }
      }
    }

    const transformedPluginsTuple = [
      resolvedPluginCode,
      ...PLANS.reduce(
        (memo, p) =>
          memo.concat([
            byPlanAndMatching[p][PluginPartType.matching],
            byPlanAndMatching[p][PluginPartType.nonmatching],
          ]),
        <string[]>[]
      ),
    ];

    // Only for minifying and treeshaking
    const builtParts = await Promise.all(
      transformedPluginsTuple.map((code, i) =>
        // it would put in the allPlugins.${pluginId} = ... code if we build with code=""
        code
          ? build({
              // entryPoints: ,
              // outdir: options.outDir,
              stdin: {
                contents: code,
                sourcefile: `${pluginId}.js`,
                resolveDir,
                loader: "js",
              },
              charset: "utf8",
              write: false,
              bundle: true,
              // for iife
              // format: "iife",
              // globalName: `allPlugins.${pluginId}`,
              format: "esm",
              treeShaking: true,
              minify: prod,
              minifyWhitespace: prod,
              minifySyntax: true,
              // incremental: true,
              // defaults to esNext (we build to the target with tsc)
              target: "es2019",
            }).catch((e) => {
              console.log(`Error building ${i}\n${e}`);
              throw e;
            })
          : Promise.resolve({ outputFiles: [{ text: "" }] })
      )
    );
    const splitPluginTuple = builtParts.map((f) =>
      f ? f.outputFiles[0].text : f
    );

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
          [baseImportsStr + splitPluginTuple[0], ...matchingNonMatching].join(
            PLUGIN_SPLIT_SEQ
          )
        );
    }
    return [<PluginSub>finalPluginsTuple, version];
  } catch (e) {
    console.error(e);
    throw e;
  } finally {
    // cleanup
    buildRes.rebuild?.dispose();
  }
}

function uneval(l: any): string {
  switch (true) {
    // case l instanceof Function: // (does not work for async functions)
    case typeof l === "function":
      /**
       * Handle named functions.
       * e.g.
       *   {
       *    init() { ... }
       *   }
       */
      const stringified: string = l.toString();
      const name = l.name;
      return name && new RegExp(`^(async )?${name}`).test(stringified)
        ? stringified.replace(name, "function")
        : stringified.toString();
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
      if (l.startsWith(REPLACED_FN_SYMBOL))
        return `${l.substr(REPLACED_FN_SYMBOL.length)}`;
      return `"${l.replace(/"/g, '\\"')}"`;
    default:
      return l;
  }
}
