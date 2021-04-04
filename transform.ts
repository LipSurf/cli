/// <reference types="lipsurf-types/extension"/>
import {
  PLANS,
  PLUGIN_SPLIT_SEQ,
  EXT_ID,
  FREE_PLAN,
  PLUS_PLAN,
  PREMIUM_PLAN,
} from "lipsurf-common/cjs/constants";
import { build } from "esbuild";
import {
  ExportDefaultExpression,
  KeyValueProperty,
  ModuleDeclaration,
  parseSync,
  printSync,
} from "@swc/core";
const importPluginBase = `import PluginBase from 'chrome-extension://${EXT_ID}/dist/modules/plugin-base.js';`;
const importExtensionUtil = `import ExtensionUtil from 'chrome-extension://${EXT_ID}/dist/modules/extension-util.js';`;

type PluginSub = [free: string, plus: string, premium: string];
enum PluginPartType {
  "matching",
  "nonmatching",
}

function versionConvertDots(v) {
  return v.replace(/\./g, "-");
}

export async function make(
  pluginId: string,
  source: string,
  langPlugins: string[],
  resolveDir: string = __dirname,
  baseImports = true
): Promise<PluginSub> {
  // const [freePlugin, plusPlugin, premPlugin] = PLANS.map((plan) =>
  //   replaceCmdsAbovePlan(plugin, plan)
  // );
  source += langPlugins
    .map(
      (langPlugin) =>
        `import ".${langPlugin.substr(
          langPlugin.lastIndexOf("/"),
          langPlugin.lastIndexOf(".")
        )}";`
    )
    .join("");

  console.time("before");
  const byPlanAndMatching = {
    [FREE_PLAN]: {},
    [PLUS_PLAN]: {},
    [PREMIUM_PLAN]: {},
  };

  let parsed = parseSync(source, { syntax: "ecmascript", dynamicImport: true });
  const cloneStr = JSON.stringify(parsed);
  let i = 0;
  for (const plan of PLANS) {
    for (const type of Object.values(PluginPartType).filter((x) =>
      isNaN(Number(x))
    )) {
      let code: string;
      try {
        code = printSync(
          new ConsoleStripper(plan, PluginPartType[type]).visitProgram(parsed)
        ).code;
      } catch (e) {
        if (e instanceof BlankPartError) code = "";
        else throw new Error(`Error transforming ${pluginId}.${plan} ${e}`);
      }
      byPlanAndMatching[plan][type] = code;
      // work with copies
      if (i != 5) {
        i++;
        parsed = JSON.parse(cloneStr);
      }
    }
  }
  console.timeEnd("before");

  const transformedPluginsTuple = [
    source,
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

  const finalPluginsTuple: Partial<PluginSub> = [];
  // combine the files into .ls file
  for (let i = 0; i < PLANS.length; i++) {
    const matchingNonMatching = splitPluginTuple.slice(
      i * 2 + 1,
      (1 + i) * 2 + 1
    );
    if (matchingNonMatching.reduce((memo, x) => memo + x.length, 0) === 0)
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

// SpreadElement doesn't have generic
interface WrappedExpression<T> {
  spread: null;
  expression: T;
}

class BlankPartError extends Error {}

class ConsoleStripper extends Visitor {
  pluginProps: Property[] = [];

  constructor(private buildForPlan: plan, private type: PluginPartType) {
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

  /**
   * throws BlankPartError if there's no commands on this plan and we're building
   * for a non-free plan.
   * @param commands
   * @returns
   */
  replaceCmdsAbovePlan(commands: ObjectExpression): ObjectExpression {
    let cmdsOnThisPlan: boolean = false;
    const pluginPlan =
      (<NumericLiteral>this.getPluginProp("plan")?.value)?.value || 0;
    // if nothing is replaced, and the highestLevel is lower than build for plan, then return false so we
    // don't build for this level (the highest level might have been 10 or 0, and already built)
    // @ts-ignore
    commands.properties = (<KeyValueProperty[]>commands.properties).map(
      (cmdObj) => {
        const cmdVal = <ObjectExpression>cmdObj.value;
        const cmdPlan =
          // @ts-ignore
          (<NumericLiteral>(
            cmdVal.properties.find(
              (p) =>
                p.type === "KeyValueProperty" &&
                p.key.type === "Identifier" &&
                p.key.value === "plan"
            )
          ))?.value || 0;
        const minNeededPlan = cmdPlan ? cmdPlan : pluginPlan;
        let replace = false;
        if (!cmdPlan) {
          // @ts-ignore
          if (pluginPlan === this.buildForPlan) cmdsOnThisPlan = true;
          // @ts-ignore
          else if (pluginPlan > this.buildForPlan) replace = true;
        } else {
          if (this.buildForPlan === cmdPlan) cmdsOnThisPlan = true;
          if (minNeededPlan > this.buildForPlan) replace = true;
        }
        if (replace) {
          // @ts-ignore
          cmdVal.properties = cmdVal.properties.reduce((memo, p) => {
            // @ts-ignore
            const key = p.key;
            if (key.value === "pageFn") {
              // @ts-ignore
              p.value = (<ExpressionStatement>(
                parseSync(
                  `() => showNeedsUpgradeError({ plan: ${minNeededPlan} })`
                ).body[0]
              )).expression;
            } else if (key.value === "plan") return memo;
            memo.push(p);
            return memo;
          }, <(SpreadElement | Property)[]>[]);
        }
        return cmdObj;
      }
    );
    if (!cmdsOnThisPlan && this.buildForPlan !== 0) throw new BlankPartError();
    return commands;
  }

  private getPluginProp(propName: string) {
    return <KeyValueProperty>(
      this.pluginProps.find(
        (p) =>
          p.type === "KeyValueProperty" &&
          p.key.type === "Identifier" &&
          p.key.value === propName
      )
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
        this.pluginProps = <Property[]>(
          (<ObjectExpression>pluginObjectExp.arguments).properties
        );
        // console.log(pluginProps);
        (<ObjectExpression>(
          pluginObjectExp.arguments
        )).properties = this.pluginProps.filter(
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
        const commandsProp = this.getPluginProp("commands");
        if (commandsProp) {
          const commandsArr = <ArrayExpression>commandsProp.value;
          // only global commands
          if (this.type === PluginPartType.nonmatching) {
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
          const newCmds = this.replaceCmdsAbovePlan(
            this.commandArrayToObject(commandsArr)
          );
          if (
            newCmds.properties.length === 0 &&
            !this.getPluginProp("init") &&
            !this.getPluginProp("destroy")
          ) {
            throw new BlankPartError();
          } else {
            commandsProp.value = newCmds;
          }
        }
      }
    }
    return n;
  }
}
