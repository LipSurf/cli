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

# Debugging
To debug ParsedPlugin.ts:

1) Go into a project with LipSurf plugins.

2) `$ node --inspect-brk ./node_modules/lipsurf-cli/lipsurf-cli build`


