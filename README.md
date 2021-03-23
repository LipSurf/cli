lipsurf-cli
===========

## Create plugin file

```
USAGE
  $ lipsurf-cli init [FILE]

ARGUMENTS
  [FILE] The filename of the plugin you want to initialize

EXAMPLE
  $ lipsurf-cli init Reddit
  Successfully created new plugin "Reddit"!
```


## Build plugin 

```
	Usage
	  $ lipsurf-cli build -o/--out-dir [OUTDIR] [...PLUGINS]

	Options
    --watch
    --out-dir/-o
    --no-base-imports

	Examples
	  $ lipsurf-cli build --watch
```

## What it does internally
Needs to separate the plugin into 3 parts:

* backend - the complete plugin, used by the extension background page. Needs plugin meta, homophones, contexts, cmd match phrases, cmd fn data, etc.
* matching content-script (cs) - when the URL matches for the plugin. Has only the parts that are needed to run on the page: init, destroy, and pageFn, dynamic match fns, etc.
* non-matching cs - when the URL doesn't match for the plugin. Has only global commands, init, destroy.

Other stuff:
* Removes unnecessary properties (e.g. test code, homophones etc.)
* Tree-shakes after removing unnecessary properties

# Debugging
To debug ParsedPlugin.ts:

1) Go into a project with LipSurf plugins.

2) `$ node --inspect-brk ./node_modules/lipsurf-cli/lipsurf-cli build`

