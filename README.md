lipsurf-cli
===========



[![oclif](https://img.shields.io/badge/cli-oclif-brightgreen.svg)](https://oclif.io)
[![Version](https://img.shields.io/npm/v/lipsurf-cli.svg)](https://npmjs.org/package/lipsurf-cli)
[![Downloads/week](https://img.shields.io/npm/dw/lipsurf-cli.svg)](https://npmjs.org/package/lipsurf-cli)
[![License](https://img.shields.io/npm/l/lipsurf-cli.svg)](https://github.com/LipSurf/lipsurf-cli/blob/master/package.json)

<!-- toc -->
* [Usage](#usage)
* [Commands](#commands)
<!-- tocstop -->
# Usage
<!-- usage -->
```sh-session
$ npm install -g lipsurf-cli
$ lipsurf-cli COMMAND
running command...
$ lipsurf-cli (-v|--version|version)
lipsurf-cli/0.0.0 linux-x64 node-v12.4.0
$ lipsurf-cli --help [COMMAND]
USAGE
  $ lipsurf-cli COMMAND
...
```
<!-- usagestop -->
# Commands
<!-- commands -->
* [`lipsurf-cli hello [FILE]`](#lipsurf-cli-hello-file)
* [`lipsurf-cli help [COMMAND]`](#lipsurf-cli-help-command)

## `lipsurf-cli hello [FILE]`

describe the command here

```
USAGE
  $ lipsurf-cli hello [FILE]

OPTIONS
  -f, --force
  -h, --help       show CLI help
  -n, --name=name  name to print

EXAMPLE
  $ lipsurf-cli hello
  hello world from ./src/hello.ts!
```

_See code: [src/commands/hello.ts](https://github.com/LipSurf/lipsurf-cli/blob/v0.0.0/src/commands/hello.ts)_

## `lipsurf-cli help [COMMAND]`

display help for lipsurf-cli

```
USAGE
  $ lipsurf-cli help [COMMAND]

ARGUMENTS
  COMMAND  command to show help for

OPTIONS
  --all  see all commands in CLI
```

_See code: [@oclif/plugin-help](https://github.com/oclif/plugin-help/blob/v2.2.0/src/commands/help.ts)_
<!-- commandsstop -->
