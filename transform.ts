/*;
 * Split the plugin into a frontend/backend and a matching/non-matching URL for
 * frontend. Frontend needs to be loaded on every page, so it should be lightweight.
 *
 * We operate on the eval'd plugin js because (with the node VM module)
 * because manipulating the js object is much more straightforward, less tedious
 * and less error prone.
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
import {
  Expression,
  StringLiteral,
  ExpressionStatement,
  CallExpression,
  Script,
  printSync,
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

function removeLanguageCodes(pluginId, code: string): string {
  let res = code;
  const regx = new RegExp(`${pluginId}_default\.languages\..{2} = {`);
  let regxRes: RegExpExecArray | null;
  let codeResOffset = 0;
  do {
    regxRes = regx.exec(res);
    if (regxRes) {
      const startBraceI = regxRes.index + regxRes[0].length;
      res = res.substr(findClosingBrace(res, startBraceI) + 1);
      code = `${code.substr(0, codeResOffset + regxRes.index)}${res}`;
      codeResOffset += regxRes.index;
    }
  } while (regxRes);
  return code;
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
  visitCallExpression(c: CallExpression): Expression {
    const stmt: ExpressionStatement = {
      span: c.span,
      type: "ExpressionStatement",
      expression: c,
    };
    const script: Script = {
      type: "Script",
      body: [stmt],
      span: c.span,
      interpreter: "",
    };
    const strLit: StringLiteral = {
      type: "StringLiteral",
      span: c.span,
      value: `${REPLACED_FN_SYMBOL}${printSync(script).code.substr(3)}`,
      has_escape: false,
    };
    return strLit;
  }
}

export async function makePlugin(
  pluginId: string,
  pluginWLanguageFiles: string[],
  resolveDir: string,
  prod = false,
  baseImports = true
): Promise<[pluginForSub: PluginSub, version: string]> {
  let buildRes;
  let builtPartsPassed: any[] = [];
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

    // bundle the deps
    buildRes = await build({
      stdin: {
        contents: importPluginDepsCode,
        sourcefile: `dumby.js`,
        resolveDir,
        loader: "js",
      },
      charset: "utf8",
      format: "esm",
      write: false,
      bundle: true,
      incremental: true,
    });
    let resolvedPluginCode = <string>buildRes.outputFiles[0].text;

    resolvedPluginCode = resolvedPluginCode.replace(
      "...PluginBase",
      "...PluginBase, ...{languages: {}}"
    );

    const byPlanAndMatching = {
      [FREE_PLAN]: {},
      [PLUS_PLAN]: {},
      [PREMIUM_PLAN]: {},
    };
    const searchQ = `var ${pluginId}_default = {`;
    const pluginSrcReplacementStartI =
      resolvedPluginCode.search(new RegExp(searchQ)) + searchQ.length;
    const pluginSrcReplacementEndI = findClosingBrace(
      resolvedPluginCode,
      pluginSrcReplacementStartI
    );

    const languageObjsRemovedCode = removeLanguageCodes(
      pluginId,
      resolvedPluginCode
    );

    // currently broken
    // resolvedPluginCode = transformSync(resolvedPluginCode, {
    //   plugin: (m) => new FnReplacer().visitProgram(m),
    // });

    let i = 0;
    let parsedPluginObj: IPlugin;
    try {
      parsedPluginObj = await evalPlugin(resolvedPluginCode);
    } catch (e) {
      throw new Error(`Error evaluating ${e}`);
    }
    const version = parsedPluginObj.version || "1.0.0";
    const exportRegx = new RegExp(
      `var\\s*dumby_default\\s*=\\s*${pluginId}_default;\\s*export\\s+{\\s*dumby_default\\s+as\\s+default\\s*};?`
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
          )}...PluginBase, ...${uneval(
            makeCS(cloned, plan, type)
          )}${languageObjsRemovedCode.substr(pluginSrcReplacementEndI)}`;
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
          throw new Error("Could not find the export regx in code");
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
              incremental: true,
              // defaults to esNext (we build to the target with tsc)
              target: "es2019",
            })
              .then((res) => {
                builtPartsPassed.push(res);
                return res;
              })
              .catch((e) => {
                throw new Error(`Error building ${i}\n${e}`);
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
  } finally {
    // cleanup
    builtPartsPassed.map((b) => b?.rebuild?.dispose());
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
