"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.evalPlugin = void 0;
/**
 * Built for simplicity and speed.
 */
const vm_1 = __importDefault(require("vm"));
const promises_1 = require("fs/promises");
const resolve_1 = __importDefault(require("resolve"));
// Only needed for getting version, because
// esbuild links in the bundling step for building (so we can work
// with the complete bundled source code).
class Linker {
    constructor(resolver, basedir) {
        this.resolver = resolver;
        this.basedir = basedir;
    }
    async link(specifier, referencingModule) {
        try {
            console.log("baseDir", this.basedir, "specifier", specifier, "referencing module", referencingModule);
            const filePath = await new Promise((cb) => this.resolver(specifier, {
                basedir: this.basedir,
            }, (err, res) => cb(res)));
            const file = await (0, promises_1.readFile)(filePath, "utf8");
            console.log("context", referencingModule.context);
            // @ts-ignore
            return new vm_1.default.SourceTextModule(file, {
                context: referencingModule.context,
            });
        }
        catch (e) {
            throw new Error(`Error linking ${specifier}\n${e}`);
        }
    }
}
async function evalPlugin(code, resolveDir) {
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
    vm_1.default.createContext(context);
    if (!("SourceTextModule" in vm_1.default))
        throw new Error("Must run node with --experimental-vm-modules");
    // @ts-ignore
    const mod = new vm_1.default.SourceTextModule(code, { context });
    if (typeof resolveDir === "undefined") {
        await mod.link(() => {
            throw new Error("Unexpected linking. Code should have been linked by esbuild in a prior step!");
        });
    }
    else {
        const linker = new Linker(resolve_1.default, resolveDir);
        await mod.link(linker.link.bind(linker));
    }
    await mod.evaluate();
    return mod.namespace.default;
}
exports.evalPlugin = evalPlugin;
