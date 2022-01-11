LipSurf-CLI
===========
Used for building and running utilities on [LipSurf](www.lipsurf.com) plugins.

## Install
```
yarn add --dev @lipsurf/cli
```

## Scaffold a project

```
Usage: lipsurf-cli init [options] <project_name>

Makes a template project with a "Hello World" plugin as a useful starting point.

Options:
  -h, --help  display help for command

Examples:
  $ lipsurf-cli init Reddit
```


## Build plugin 

```
Usage: lipsurf-cli build [options] [PLUGIN_PATHS_OR_IDS...]

Build LipSurf plugins. By default builds all plugins under src/ within a directory of the plugin's name.

Options:
  -w, --watch
  -t, --check                  check TypeScript types
  --no-base-imports
  -p, --project                tsconfig file path (default: "./tsconfig.json")
  -o, --out-dir <destination>  destination directory (default: "dist")
  -h, --help                   display help for command

Examples:
  $ lipsurf-cli build --watch
```

## What plugin building does
Creates a `[plugin id].[version].[plan].ls` file. Plan is 0 if the plugin is free. Multiple plan version are created if the plugin has payed and free parts.
The file contains three parts delineated by a special separator.

* backend - the complete plugin, used by the extension background page. Needs plugin meta, homophones, contexts, cmd match phrases, cmd fn data, etc.
* matching content-script (cs) - when the URL matches for the plugin. Has only the parts that are needed to run on the page: init, destroy, and pageFn, dynamic match fns, etc.
* non-matching cs - when the URL doesn't match for the plugin. Has only global commands, init, destroy.

Other stuff:
* Removes unnecessary properties (e.g. test code, homophones etc.)
* Tree-shakes after removing unnecessary properties

# Debugging
To debug the plugin builder:

1) Go into a project with LipSurf plugins.

2) (optional) Add `sourceMap: true` to cli/tsconfig.json.

2) `$ node --inspect-brk --experimental-vm-modules ./node_modules/@lipsurf/cli/lib/lipsurf-cli.js build`

