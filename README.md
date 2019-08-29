lipsurf-cli
===========

To debug split.ts:
Go into the project with example plugins: 
$ node --inspect-brk ./node_modules/lipsurf-cli/lipsurf-cli build


```
USAGE
  $ lipsurf-cli init [FILE]

ARGUMENTS
  [FILE] The filename of the plugin you want to initialize

EXAMPLE
  $ lipsurf-cli init Reddit
  Successfully created new plugin "Reddit"!
```


## `lipsurf-cli build`

```
	Usage
	  $ lipsurf-cli build -o/--out-dir [OUTDIR] [...PLUGINS]

	Options
    --watch
    --out-dir/-o

	Examples
	  $ lipsurf-cli build --watch
```
