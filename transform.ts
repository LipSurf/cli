/// <reference types="lipsurf-types/extension"/>
import { PLANS } from "lipsurf-common/cjs/constants";
import { buildSync } from "esbuild";
import {
  ExportDefaultExpression,
  ExportDefaultSpecifier,
  ExportSpecifier,
  KeyValueProperty,
  Module,
  ModuleDeclaration,
  transformSync,
} from "@swc/core";

declare let showNeedsUpgradeError: any;

export function make(source: string, resolveDir: string = __dirname) {
  // const [freePlugin, plusPlugin, premPlugin] = PLANS.map((plan) =>
  //   replaceCmdsAbovePlan(plugin, plan)
  // );
  const { code, map } = transformSync(source, {
    jsc: {
      target: "es2019",
    },
    plugin: (m) => new ConsoleStripper().visitProgram(m),
  });
  console.log("before transform:", code);
  const transformed = buildSync({
    // entryPoints: ,
    // outdir: options.outDir,
    stdin: {
      contents: code,
      sourcefile: "dumby.js",
      resolveDir,
      loader: "js",
    },
    write: false,
    bundle: true,
    minify: true,
    minifyWhitespace: true,
    minifySyntax: true,
    target: "es2019",
  });

  console.log(
    "after transform:",
    new TextDecoder().decode(transformed.outputFiles[0].contents)
  );
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

class ConsoleStripper extends Visitor {
  // no good be
  // visitProperty(node: Property): Property {
  //   console.log(node.type);
  //   if (node.type === "KeyValueProperty")
  //     console.log("key", node.key, "val", node.value);
  //   return node;
  // }

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
        const commandsProp = <ArrayExpression>(
          (<KeyValueProperty | undefined>(
            pluginProps.find(
              (p) =>
                p.type === "KeyValueProperty" &&
                p.key.type === "Identifier" &&
                p.key.value === "commands"
            )
          ))?.value
        );
        if (commandsProp) {
          commandsProp.elements.forEach((e: any) => {
            e.expression.properties = e.expression.properties.filter(
              (p: KeyValueProperty) => {
                if (
                  p.key.type === "Identifier" &&
                  COMMAND_PROPS_TO_REMOVE_FROM_CS.includes(p.key.value)
                )
                  return false;
                return true;
              }
            );
          });
        }
      }
    }
    return n;
  }
}
