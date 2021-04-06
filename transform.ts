/**
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
import {
  PLANS,
  PLUGIN_SPLIT_SEQ,
  EXT_ID,
  FREE_PLAN,
  PLUS_PLAN,
  PREMIUM_PLAN,
} from "lipsurf-common/cjs/constants";
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

class BlankPartError extends Error {}

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

export async function makePlugin(
  pluginId: string,
  pluginWLanguageFiles: string[],
  resolveDir: string,
  prod = false,
  baseImports = true
): Promise<[pluginForSub: PluginSub, version: string]> {
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

  // console.log("start", pluginSrcReplacementStartI, pluginSrcReplacementEndI);
  // console.log(
  //   resolvedPluginCode.substring(
  //     pluginSrcReplacementStartI,
  //     pluginSrcReplacementEndI
  //   )
  // );
  const languageObjsRemovedCode = removeLanguageCodes(
    pluginId,
    resolvedPluginCode
  );

  let i = 0;
  let parsedPluginObj: IPlugin;
  try {
    parsedPluginObj = await evalPlugin(resolvedPluginCode);
  } catch (e) {
    throw new Error(`Error evaluating ${pluginId}: ${e}`);
  }
  const version = parsedPluginObj.version || "1.0.0";
  const cloneStr = JSON.stringify(parsedPluginObj);
  for (const plan of PLANS) {
    let type: PluginPartType;
    for (type of Object.values<PluginPartType>(
      <any>PluginPartType
    ).filter((x) => isNaN(Number(x)))) {
      let code: string;
      try {
        code = `${languageObjsRemovedCode.substr(
          0,
          pluginSrcReplacementStartI
        )}...PluginBase, ...${uneval(
          makeCS(parsedPluginObj, plan, type)
        )}${languageObjsRemovedCode.substr(pluginSrcReplacementEndI)}`;
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
          treeShaking: true,
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
                /export {\s+dumby_default as default\s+};/,
                `return dumby_default;`
              )} })();`
          ),
        ].join(PLUGIN_SPLIT_SEQ)
      );
  }

  return [<PluginSub>finalPluginsTuple, version];
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
      return `"${l.replace(/"/g, '\\"')}"`;
    default:
      return l;
  }
}
