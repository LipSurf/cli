import {Command, flags} from '@oclif/command'

export default class Build extends Command {
  static description = 'Builds LipSurf plugins into .ls files that can be loaded into LipSurf.'

  static examples = [
    `$ lipsurf-cli build
$ lipsurf-cli build --watch`,
  ]

  static flags = {
    help: flags.help({char: 'h'}),
    watch: flags.boolean(),
  }

  async run() {
    const {args, flags} = this.parse(Build)

    const watch = flags.watch;
    this.log(`Done building.`);
  }
}
