/**
 * Built for simplicity and speed.
 */
import vm from "vm";
import { readFile } from "fs/promises";
import resolve from "resolve";

// Only needed for getting version, because
// esbuild links in the bundling step for building (so we can work
// with the complete bundled source code).
class Linker {
  constructor(private resolver, private basedir: string) {}

  async link(specifier, referencingModule) {
    try {
      console.log(
        "baseDir",
        this.basedir,
        "specifier",
        specifier,
        "referencing module",
        referencingModule
      );
      const filePath = await new Promise<string>((cb) =>
        this.resolver(
          specifier,
          {
            basedir: this.basedir,
          },
          (err, res) => cb(res)
        )
      );
      const file = await readFile(filePath, "utf8");
      console.log("context", referencingModule.context);
      // @ts-ignore
      return new vm.SourceTextModule(file, {
        context: referencingModule.context,
      });
    } catch (e) {
      throw new Error(`Error linking ${specifier}\n${e}`);
    }
  }
}

export async function evalPlugin(
  code: string,
  resolveDir?: string
): Promise<IPlugin> {
  /**
   * TODO: better way of getting the PluginBase necessities
   */
  const context = {
    // this: {},
    global: {},
    exports: {},
    window: {
      addEventListener: () => null,
    },
    document: {
      getElementById: () => null,
    },
    module: {
      exports: {},
    },
    chrome: {
      runtime: {
        connect: () => null,
      },
    },
    PluginBase: {
      // proxy didn't work here :(
      util: {
        getNoCollisionUniqueAttr: () => null,
      },
      help: {},
      annotations: {},
      languages: {},
    },
  };
  vm.createContext(context);
  if (!("SourceTextModule" in vm))
    throw new Error("Must run node with --experimental-vm-modules");
  // @ts-ignore
  const mod = new vm.SourceTextModule(code, { context });
  if (typeof resolveDir === "undefined") {
    await mod.link(() => {
      throw new Error(
        "Unexpected linking. Code should have been linked by esbuild in a prior step!"
      );
    });
  } else {
    const linker = new Linker(resolve, resolveDir);
    await mod.link(linker.link.bind(linker));
  }
  await mod.evaluate();
  return mod.namespace.default;
}
