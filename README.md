lipsurf-cli
===========

To debug split.ts:
1) Install necessary deps.
$ yarn add https://github.com/lipsurf/plugin-types ...

2) Copy over source files to use as samples
$ mkdir src && cp -r ../chrome-extension/premium-plugins/src/Date ./src/

3) node --inspect-brk ./lipsurf-cli build


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
USAGE
  $ lipsurf-cli build

OPTIONS
  --watch  watch for file changes and automatically build when there's a change.
```
