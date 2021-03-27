/// <reference types="lipsurf-types/extension"/>
import { PLANS, PLUGIN_SPLIT_SEQ, EXT_ID } from "lipsurf-common/cjs/constants";
import { build } from "esbuild";
import {
  ExportDefaultExpression,
  ExportDefaultSpecifier,
  ExportSpecifier,
  KeyValueProperty,
  Module,
  ModuleDeclaration,
  transform,
  parse,
  parseSync,
  printSync,
} from "@swc/core";
const importPluginBase = `import PluginBase from 'chrome-extension://${EXT_ID}/dist/modules/plugin-base.js';`;
const importExtensionUtil = `import ExtensionUtil from 'chrome-extension://${EXT_ID}/dist/modules/extension-util.js';`;

declare let showNeedsUpgradeError: any;

function versionConvertDots(v) {
  return v.replace(/\./g, "-");
}

export async function make(
  pluginId: string,
  source: string,
  langPlugins: string[],
  resolveDir: string = __dirname,
  baseImports = true
) {
  // const [freePlugin, plusPlugin, premPlugin] = PLANS.map((plan) =>
  //   replaceCmdsAbovePlan(plugin, plan)
  // );
  console.log("langPlugins", langPlugins);
  source += langPlugins
    .map(
      (langPlugin) =>
        `import ".${langPlugin.substr(
          langPlugin.lastIndexOf("/"),
          langPlugin.lastIndexOf(".")
        )}";`
    )
    .join("");
  const transformedPluginsTuple = [
    source,
    ...(
      await Promise.all(
        [true, false].map((isMatching) =>
          transform(source, {
            jsc: {
              target: "es2020",
            },
            plugin: (m) => new ConsoleStripper(isMatching).visitProgram(m),
          }).catch((e) => {
            if (e instanceof BlankError) return { code: "" };
            throw e;
          })
        )
      )
    ).map((p) => p.code),
  ];
  console.log("after transform:\n", transformedPluginsTuple[1]);
  console.log("after transform (nonmatching):\n", transformedPluginsTuple[2]);

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
          // minify: true,
          format: "esm",
          minifyWhitespace: false,
          minifySyntax: true,
          // defaults to esNext (we build to the target with tsc)
          // target: "es2019",
        })
      )
    )
  ).map((f) => new TextDecoder().decode(f.outputFiles[0].contents));

  // console.log(splitPluginTuple[0]);

  // console.log("after transform:");
  let baseImportsStr = "";
  if (baseImports) {
    baseImportsStr = importPluginBase + importExtensionUtil;
  }

  // combine the files into .ls file
  return [
    baseImportsStr,
    splitPluginTuple
      .map(
        (s) =>
          `allPlugins.${pluginId} = (() => { ${s.replace(
            `export default require_${pluginId}()`,
            `return require_${pluginId}().default`
          )} })();`
        // new TextDecoder()
        //   .decode(f.outputFiles[0].contents)
        //   // .replace(
        //   //   `default: () => ${pluginId}_default`,
        //   //   `default: ${pluginId}_default`
        //   // )
        //   .replace("var allPlugins = allPlugins || {};", "") +
      )
      .join(PLUGIN_SPLIT_SEQ),
  ].join("");
}

/**
 * Add pageFn to commands that only have fn.
 * @param j
 * @param plugin
 * @param pluginPlan
 * @returns if we should output for this plan (if there are specific commands in this level)
 */
export function replaceCmdsAbovePlan(
  plugin: IPlugin,
  buildForPlan: number
): boolean {
  let cmdsOnThisPlan: boolean = false;
  const pluginPlan = plugin.plan || 0;
  plugin.commands.map((cmdObj) => {
    const cmdPlan = cmdObj.plan || 0;
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
      cmdObj.pageFn = () => showNeedsUpgradeError({ plan: minNeededPlan });
    }
    return cmdObj;
  });
  // if nothing is replaced, and the highestLevel is lower than build for plan, then return false so we
  // don't build for this level (the highest level might have been 10 or 0, and already built)
  return cmdsOnThisPlan || buildForPlan === 0;
}

import {
  CallExpression,
  Expression,
  Property,
  SpreadElement,
  ObjectExpression,
  ArrayExpression,
} from "@swc/core";
import Visitor from "@swc/core/Visitor";
import { pbkdf2 } from "crypto";

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

// SpreadElement doesn't have generic
interface WrappedExpression<T> {
  spread: null;
  expression: T;
}

class BlankError extends Error {}

class ConsoleStripper extends Visitor {
  // no good be
  // visitProperty(node: Property): Property {
  //   console.log(node.type);
  //   if (node.type === "KeyValueProperty")
  //     console.log("key", node.key, "val", node.value);
  //   return node;
  // }
  constructor(private isMatching: boolean) {
    super();
  }

  /**
   * Keyed by command name
   * @param cmds
   * @returns
   */
  private commandArrayToObject(cmds: ArrayExpression): ObjectExpression {
    return (<WrappedExpression<ObjectExpression>[]>(
      (<unknown>cmds.elements)
    )).reduce(
      (memo, cmd) => {
        // only the name property? Blank command
        if (cmd.expression.properties.length === 1) return memo;
        const namePropI = cmd.expression.properties.findIndex(
          (p) =>
            p.type === "KeyValueProperty" &&
            p.key.type === "Identifier" &&
            p.key.value === "name"
        )!;
        const nameProp = <KeyValueProperty>(
          cmd.expression.properties.splice(namePropI, 1)[0]
        );
        // const nameProp = cmd.expression.properties[namePropI];
        // @ts-ignore
        memo.properties.push({
          type: "KeyValueProperty",
          key: {
            type: "StringLiteral",
            hasEscape: false,
            kind: { type: "normal", containsQuote: true },
            // @ts-ignore
            span: nameProp.value.span,
            // @ts-ignore
            value: nameProp.value.value,
          },
          span: cmds.span,
          value: cmd.expression,
        });
        return memo;
      },
      {
        type: "ObjectExpression",
        properties: <any[]>[],
        span: cmds.span,
      }
    );
  }

  visitExportDefaultExpression(n: ExportDefaultExpression): ModuleDeclaration {
    if (n.expression.type === "ObjectExpression") {
      const pluginObjectExp = <SpreadElement | undefined>(
        n.expression.properties.find(
          (p) =>
            p.type === "SpreadElement" &&
            p.arguments.type === "ObjectExpression"
        )
      );
      if (pluginObjectExp) {
        const pluginProps = (<ObjectExpression>pluginObjectExp.arguments)
          .properties;
        // console.log(pluginProps);
        (<ObjectExpression>(
          pluginObjectExp.arguments
        )).properties = pluginProps.filter(
          (prop) =>
            !(
              (prop.type === "Identifier" &&
                PLUGIN_PROPS_TO_REMOVE_FROM_CS.includes(prop.value)) ||
              ((prop.type === "KeyValueProperty" ||
                prop.type === "MethodProperty") &&
                prop.key.type === "Identifier" &&
                PLUGIN_PROPS_TO_REMOVE_FROM_CS.includes(prop.key.value))
            )
        );
        const commandsProp = <KeyValueProperty | undefined>(
          pluginProps.find(
            (p) =>
              p.type === "KeyValueProperty" &&
              p.key.type === "Identifier" &&
              p.key.value === "commands"
          )
        );
        if (commandsProp) {
          const commandsArr = <ArrayExpression>commandsProp.value;
          // only global commands
          if (!this.isMatching) {
            // @ts-ignore
            commandsArr.elements = commandsArr.elements.filter((e: any) =>
              e.expression.properties.find(
                (p) =>
                  p.type === "KeyValueProperty" &&
                  p.key.type === "Identifier" &&
                  p.key.value === "global" &&
                  p.value.type === "BooleanLiteral" &&
                  p.value.value
              )
            );
          }
          commandsArr.elements.forEach((e: any) => {
            e.expression.properties = e.expression.properties.filter(
              (p: KeyValueProperty) => {
                if (p.key.type === "Identifier") {
                  if (COMMAND_PROPS_TO_REMOVE_FROM_CS.includes(p.key.value))
                    return false;
                  else if (
                    p.key.value === "match" &&
                    ["StringLiteral", "ArrayExpression"].includes(p.value.type)
                  )
                    return false;
                }
                return true;
              }
            );
          });
          const newCmds = this.commandArrayToObject(commandsArr);
          debugger;
          if (newCmds.properties.length === 0) {
            throw new BlankError();
          } else {
            commandsProp.value = newCmds;
          }
        }
      }
    }
    return n;
  }
}
