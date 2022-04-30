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
      // .split('=') may not work because '=' could be present in the key
      const index = x.indexOf("=");
      const splitted = [x.slice(0, index), x.slice(index + 1)];
      return { ...memo, ...{ [splitted[0]]: splitted[1] } };
    }, {});

export function escapeQuotes(str: string): string {
  return str.replace(/"/g, '\\"');
}
