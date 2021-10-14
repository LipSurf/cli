import * as fs from "fs";

export enum PluginPartType {
  "matching",
  "nonmatching",
}

export const getDotEnv = (dotEnvF: string) =>
  fs
    .readFileSync(dotEnvF)
    .toString()
    .split("\n")
    .filter((x) => x)
    .reduce((memo, x) => {
      const splitted = x.split("=");
      return { ...memo, ...{ [splitted[0]]: splitted[1] } };
    }, {});

export function escapeQuotes(str: string): string {
  return str.replace('"', '\\"');
}
