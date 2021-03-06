"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.transformJSToPlugin = exports.escapeRegx = void 0;
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
 * Before we eval the plugin, we replace all fn calls with:
 *   (specialVarName = () => {/* ...fn call... * /})
 *
 * Tried making it a string, but ran into unicode escaping issues.
 * A comment in a function can still be extracted with .toString()
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
const esbuild_1 = require("esbuild");
const util_1 = require("./util");
const evaluator_1 = require("./evaluator");
const lodash_1 = require("lodash");
const path_1 = require("path");
const fs_1 = require("fs");
const core_1 = require("@swc/core");
const Visitor_1 = __importDefault(require("@swc/core/Visitor"));
const clone_1 = __importDefault(require("clone"));
// hack until we have public + private common
// import {
//   PLANS,
//   PLUGIN_SPLIT_SEQ,
//   EXT_ID,
//   FREE_PLAN,
//   PLUS_PLAN,
//   PREMIUM_PLAN,
// } from "lipsurf-common/constants.cjs";
const FREE_PLAN = 0;
const PLUS_PLAN = 10;
const PREMIUM_PLAN = 20;
const EXT_ID = "lnnmjmalakahagblkkcnjkoaihlfglon";
const PLANS = [FREE_PLAN, PLUS_PLAN, PREMIUM_PLAN];
const PURE_FUNCS = (process.env['STRIP_LOGS'] || '').toLowerCase() === 'false' ? [] :
    ['console.log', 'console.dir', 'console.trace', 'console.debug', 'console.time', 'console.timeEnd'];
const PLUGIN_SPLIT_SEQ = "\vLS-SPLIT";
// hack
// import { escapeRegx } from "lipsurf-common/util.cjs";
const escaper = /[.*+?^${}()|[\]\\]/g;
function escapeRegx(s) {
    return s.replace(escaper, "\\$&");
}
exports.escapeRegx = escapeRegx;
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
const FN_ESCAPE_TAG = `LIPSURF_FN_ESC`;
const COMMENT_ENDER_PLACEHOLDER = "LIPSURF_CMT_ENDER";
const COMMENT_ENDER_PLACEHOLDER_REGX = new RegExp(COMMENT_ENDER_PLACEHOLDER, "g");
const COMMENT_ENDER_REGEX = new RegExp("\\*/", "g");
const FN_ESCAPE_PREFIX = `=()=>{/*`;
const FN_ESCAPE_SUFFIX = `*/})`;
class BlankPartError extends Error {
}
function replaceCmdsAbovePlan(plugin, buildForPlan) {
    let cmdsOnThisPlan = false;
    const pluginPlan = plugin.plan || 0;
    // if nothing is replaced, and the highestLevel is lower than build for plan, then return false so we
    // don't build for this level (the highest level might have been 10 or 0, and already built)
    plugin.commands = plugin.commands.map((cmd) => {
        const cmdPlan = cmd.plan;
        const minNeededPlan = cmdPlan ? cmdPlan : pluginPlan;
        let replace = false;
        if (!cmdPlan) {
            if (pluginPlan === buildForPlan)
                cmdsOnThisPlan = true;
            else if (pluginPlan > buildForPlan)
                replace = true;
        }
        else {
            if (buildForPlan === cmdPlan)
                cmdsOnThisPlan = true;
            if (minNeededPlan > buildForPlan)
                replace = true;
        }
        if (replace) {
            // @ts-ignore
            cmd.pageFn = new Function(`showNeedsUpgradeError({plan: ${minNeededPlan}})`);
        }
        return cmd;
    });
    if (!cmdsOnThisPlan && buildForPlan !== 0)
        throw new BlankPartError();
    return plugin;
}
function makeCS(plugin, plan, type) {
    // must happen before we remove COMMAND_PROPS_TO_REMOVE_FROM_CS and PLUGIN_PROPS_TO_REMOVE_FROM_CS
    // since both have plan property
    plugin = replaceCmdsAbovePlan(plugin, plan);
    for (const prop of PLUGIN_PROPS_TO_REMOVE_FROM_CS) {
        delete plugin[prop];
    }
    for (let i = plugin.commands.length - 1; i >= 0; i--) {
        const cmd = plugin.commands[i];
        if (type === util_1.PluginPartType.nonmatching && !cmd.global) {
            plugin.commands.splice(i, 1);
            continue;
        }
        for (const prop of COMMAND_PROPS_TO_REMOVE_FROM_CS) {
            delete cmd[prop];
        }
        if (Array.isArray(cmd.match) || typeof cmd.match === "string") {
            // @ts-ignore
            delete cmd.match;
        }
        else {
            // merge localized match fns into the plugin.commands.match object
            const oldMatch = cmd.match;
            // @ts-ignore
            cmd.match = Object.keys(plugin.languages || []).reduce((memo, lang) => {
                var _a, _b;
                const localizedFn = (_b = (_a = plugin.languages[lang]) === null || _a === void 0 ? void 0 : _a.commands[cmd.name]) === null || _b === void 0 ? void 0 : _b.match.fn;
                if (localizedFn)
                    memo[lang] = localizedFn;
                return memo;
            }, { en: oldMatch.fn });
        }
        if (typeof cmd.nice !== "function") {
            delete cmd.nice;
        }
        // only the name key
        if (Object.keys(cmd).length === 1)
            plugin.commands.splice(i, 1);
    }
    if (!plugin.commands.length && !plugin.init && !plugin.destroy)
        throw new BlankPartError();
    // array to obj
    plugin.commands = lodash_1.mapValues(lodash_1.keyBy(plugin.commands, "name"), (v) => lodash_1.omit(v, "name"));
    // remove plugin-base props
    for (const prop of PLUGIN_BASE_PROPS) {
        delete plugin[prop];
    }
    return plugin;
}
function replaceSpans(code, spans, replacer) {
    const codeParts = [];
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
function getLanguageDefSpans(pluginId, body) {
    return body
        .filter((x) => x.type === "ExpressionStatement" &&
        x.expression &&
        x.expression.type === "AssignmentExpression" &&
        x.expression.left &&
        x.expression.left.type === "MemberExpression" &&
        x.expression.left.object.type === "MemberExpression" &&
        x.expression.left.object.object.type === "Identifier" &&
        x.expression.left.object.object.value === `${pluginId}_default` &&
        x.expression.left.property.type === "Identifier" &&
        x.expression.left.property.value.length === 2)
        .map((x) => x.span);
}
/**
 * replace all called fns with strings, so that they
 * aren't resolved in the wrong context (when plugin
 * is building)
 * Important so that closures are preserved (eg. when
 * pageFn is a called fn with closure vars)
 */
class FnReplacer extends Visitor_1.default {
    // hack to get around span not starting at 0 in swc (last tested in v1.2.62)
    constructor(offsetHack) {
        super();
        this.offsetHack = offsetHack;
        this.callExpressionSpans = [];
    }
    visitCallExpression(c) {
        // console.log(c);
        // return c;
        // hack to get around span not starting at 0 in swc (last tested in v1.2.62)
        const start = c.span.start - this.offsetHack;
        const end = c.span.end - this.offsetHack;
        this.callExpressionSpans.push({ start, end, ctxt: c.span.ctxt });
        return c;
    }
}
function getPluginSpan(pluginId, body) {
    return body.find((x) => x.type === "VariableDeclaration" &&
        x.declarations[0].type === "VariableDeclarator" &&
        x.declarations[0].id.type === "Identifier" &&
        x.declarations[0].id.value === `${pluginId}_default` &&
        x.declarations[0].init &&
        x.declarations[0].init.type == "ObjectExpression"
    // @ts-ignore
    ).declarations[0].init.span;
}
function versionConvertDots(v) {
    return v.replace(/\./g, "-");
}
function transformJSToPlugin(pluginId, globbedTs, outdir, prod, baseImports, define) {
    const pluginWLanguageFiles = globbedTs
        .map((f) => f.replace(/^src\//, "dist/tmp/").replace(/.ts$/, ".js"))
        .filter((x) => x.substr(x.lastIndexOf("/")).includes(`/${pluginId}.`))
        .sort((a, b) => a.length - b.length);
    const resolveDir = pluginWLanguageFiles[0].substr(0, pluginWLanguageFiles[0].lastIndexOf("/"));
    return makePlugin(pluginId, pluginWLanguageFiles, resolveDir, prod, baseImports, define)
        .then((res) => {
        const version = versionConvertDots(res[1]);
        return Promise.all(res[0].map((c, i) => c
            ? fs_1.promises.writeFile(`${path_1.join(outdir, pluginId)}.${version}.${PLANS[i]}.ls`, c, "utf8")
            : undefined));
    })
        .catch((e) => {
        console.error(`Error building ${pluginId}: ${e}`);
        throw e;
    });
}
exports.transformJSToPlugin = transformJSToPlugin;
// "s" flag is so dot can match newlines as well
const ARTIFACT_REGX = new RegExp(`\\(${FN_ESCAPE_TAG}${escapeRegx(FN_ESCAPE_PREFIX)}(.*?)${escapeRegx(FN_ESCAPE_SUFFIX)}`, "gs");
function removeReplacedCallArtifacts(s) {
    return s
        .replace(ARTIFACT_REGX, "$1")
        .replace(COMMENT_ENDER_PLACEHOLDER_REGX, "*/");
}
async function makePlugin(pluginId, pluginWLanguageFiles, resolveDir, prod = false, baseImports = true, define = {}) {
    var _a;
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
        buildRes = await esbuild_1.build({
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
            minifyWhitespace: true,
            // does not minify syntax because missing comments cause offset issues with swc
        });
        const resolvedPluginCode = buildRes.outputFiles[0].text
            .replace("...PluginBase", "...PluginBase, ...{languages: {}}")
            // needed because ES build does not escape unicode characters in regex literals
            .replace(/[^\x00-\x7F]/g, (x) => `\\u${escape(x).substr(2)}`);
        const byPlanAndMatching = {
            [FREE_PLAN]: {},
            [PLUS_PLAN]: {},
            [PREMIUM_PLAN]: {},
        };
        // the fn still not recognized (last checked swc version v1.2.58)
        // const resolvedPluginCode = `
        //   function fn() { }
        //   export default {
        //     commands: [
        //       {
        //         abc: fn(),
        //       }
        //     ]
        //   };
        // `;
        const ast = await core_1.parse(resolvedPluginCode, {
            syntax: "ecmascript",
            dynamicImport: true,
        });
        let { start: pluginSrcReplacementStartI, end: pluginSrcReplacementEndI, } = getPluginSpan(pluginId, ast.body);
        // hack to get around span not starting at 0 in swc (last tested in v1.2.60)
        pluginSrcReplacementEndI = pluginSrcReplacementEndI - ast.span.start;
        pluginSrcReplacementStartI = pluginSrcReplacementStartI - ast.span.start;
        // assume languages come after plugin definition (otherwise pluginSrcReplacementStartI would need to be adjusted)
        const languageObjsRemovedCode = replaceSpans(resolvedPluginCode, getLanguageDefSpans(pluginId, ast.body));
        // console.time("escape fn calls");
        const fnReplacer = new FnReplacer(ast.span.start);
        fnReplacer.visitProgram(ast);
        const noFnCallsCode = replaceSpans(resolvedPluginCode, fnReplacer.callExpressionSpans, (code) => `(${FN_ESCAPE_TAG}${FN_ESCAPE_PREFIX}${code.replace(COMMENT_ENDER_REGEX, COMMENT_ENDER_PLACEHOLDER)}${FN_ESCAPE_SUFFIX}`);
        // console.log(noFnCallsCode);
        // console.timeEnd("escape fn calls");
        let i = 0;
        let parsedPluginObj;
        try {
            parsedPluginObj = await evaluator_1.evalPlugin(`var ${FN_ESCAPE_TAG};${noFnCallsCode}`);
        }
        catch (e) {
            throw new Error(`Error evaluating ${e}\n\ncode: ${noFnCallsCode}`);
        }
        const version = parsedPluginObj.version || "1.0.0";
        const exportRegx = new RegExp(`var\\s*${dumbySrcName}_default\\s*=\\s*${pluginId}_default;\\s*export\\s*{\\s*${dumbySrcName}_default\\s+as\\s+default\\s*};?`);
        let cloned = clone_1.default(parsedPluginObj, false);
        for (const plan of PLANS) {
            let type;
            for (type of Object.values(util_1.PluginPartType).filter((x) => !isNaN(Number(x)))) {
                let code;
                try {
                    code = `${languageObjsRemovedCode.substr(0, pluginSrcReplacementStartI)}{...PluginBase, ...${removeReplacedCallArtifacts(uneval(makeCS(cloned, plan, type)))}}${languageObjsRemovedCode.substr(pluginSrcReplacementEndI)}`;
                }
                catch (e) {
                    if (e instanceof BlankPartError)
                        code = "";
                    else
                        throw new Error(`Error transforming ${pluginId}.${plan} ${e}`);
                }
                /**
                 * Might look like this for production build:
                 * var t = { ... },
                 * l = t;
                 * var randomStuff;
                 * function randomFn() { .. }
                 * export {
                 *  l as
                 *  default
                 */
                if (code && !exportRegx.test(code)) {
                    throw new Error(`Could not find the export regex in code.`);
                }
                byPlanAndMatching[plan][type] = code
                    ? `allPlugins.${pluginId} = (() => { ${code.replace(exportRegx, "")} 
              return ${pluginId}_default; })();`
                    : "";
                // work with copies
                // don't need to make an extra copy at the end (small perf improvement)
                if (i != 5) {
                    i++;
                    cloned = clone_1.default(parsedPluginObj, false);
                }
                else {
                    cloned = parsedPluginObj;
                }
            }
        }
        const transformedPluginsTuple = [
            resolvedPluginCode,
            ...PLANS.reduce((memo, p) => memo.concat([
                byPlanAndMatching[p][util_1.PluginPartType.matching],
                byPlanAndMatching[p][util_1.PluginPartType.nonmatching],
            ]), []),
        ];
        // Only for minifying and treeshaking
        const builtParts = await Promise.all(transformedPluginsTuple.map((code, i) => 
        // it would put in the allPlugins.${pluginId} = ... code if we build with code=""
        code
            ? esbuild_1.build({
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
                // handles minifyWhitespace, minifyIdentifiers, and minifySyntax
                minify: prod,
                pure: prod ? PURE_FUNCS : [],
                // incremental: true,
                // defaults to esNext (we build to the target with tsc)
                target: "es2019",
            }).catch((e) => {
                console.log(`Error building ${i}\n${e}`);
                throw e;
            })
            : Promise.resolve({ outputFiles: [{ text: "" }] })));
        const splitPluginTuple = builtParts.map((f) => f ? f.outputFiles[0].text : f);
        let baseImportsStr = "";
        if (baseImports) {
            baseImportsStr = importPluginBase + importExtensionUtil;
        }
        const finalPluginsTuple = [];
        // combine the files into .ls file
        for (let i = 0; i < PLANS.length; i++) {
            const matchingNonMatching = splitPluginTuple.slice(i * 2 + 1, (1 + i) * 2 + 1);
            if (PLANS[i] !== FREE_PLAN &&
                // @ts-ignore
                matchingNonMatching.reduce((memo, x) => memo + x.length, 0) === 0)
                // no plugin for this level
                finalPluginsTuple.push("");
            else
                finalPluginsTuple.push([baseImportsStr + splitPluginTuple[0], ...matchingNonMatching].join(PLUGIN_SPLIT_SEQ));
        }
        return [finalPluginsTuple, version];
    }
    catch (e) {
        console.error(e);
        throw e;
    }
    finally {
        // cleanup
        (_a = buildRes.rebuild) === null || _a === void 0 ? void 0 : _a.dispose();
    }
}
function uneval(l) {
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
            const stringified = l.toString();
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
