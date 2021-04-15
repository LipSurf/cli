import { PLANS } from "lipsurf-common/cjs/constants";
import { join } from "path";
import { makePlugin } from "./transform";
import { promises as fs } from "fs";

function versionConvertDots(v) {
  return v.replace(/\./g, "-");
}

function transformJSToPlugin(
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

process.on("message", (msg) => {
  // console.log("Message from parent:", msg);
  // @ts-ignore
  transformJSToPlugin(...msg)
    .then(() => {
      process.exit(0);
    })
    .catch(() => {
      process.exit(1);
    });
});
