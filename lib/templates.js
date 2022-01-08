"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.TSCONFIG_TEMPLATE = exports.PLUGIN_TEMPLATE = exports.PACKAGE_JSON = void 0;
exports.PACKAGE_JSON = {
    name: "",
    version: "1.0.0",
    scripts: {
        build: "cross-env NODE_OPTIONS='--experimental-vm-modules --no-warnings' lipsurf-cli build",
        watch: "cross-env NODE_OPTIONS='--experimental-vm-modules --no-warnings' lipsurf-cli build --watch",
        version: "yarn clean && lipsurf-cli vup && cross-env NODE_ENV=production yarn build",
        clean: "rimraf -r dist/*",
    },
    peerDependencies: {
        typescript: "4.x",
    },
    devDependencies: {
        "@lipsurf/cli": "^2.2.1",
        "@lipsurf/types": "^2.1.1",
        "@types/chrome": "~0.0.173",
        "cross-env": "^7.0.3",
        rimraf: "^3.0.2",
    },
};
exports.PLUGIN_TEMPLATE = `/// <reference types="@lipsurf/types/extension"/>
declare const PluginBase: IPluginBase;

export default <IPluginBase & IPlugin>{
  ...PluginBase,
  ...{
    niceName: "Hello World",
    description: "",
    // a RegEx that must match against the current tab's url for the plugin to be active (all of it's commands minus global commands)
    match: /.*/,
    version: "1.0.0",
    apiVersion: 2,

    commands: [
      {
        name: "Respond",
        description:
          "Respond with something incredibly insightful to the user.",
        // what the user actually has to say to run this command
        match: "hello world",
        // the js that's run on the page
        pageFn: function () {
          alert("Hello, Developer!");
        },
      },
    ],
  },
};`;
exports.TSCONFIG_TEMPLATE = `{
  "extends": "@lipsurf/cli/plugins-tsconfig.json",
  "compilerOptions": {
    "outDir": "dist/tmp",
    "tsBuildInfoFile": "dist/tmp/.tsbuildinfo"
  },
  "include": [
    "src/*/*.ts"
  ]
}`;
