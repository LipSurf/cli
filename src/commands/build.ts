import {Command, flags} from '@oclif/command'
import * as rollup from 'rollup';
// @ts-ignore
import * as config from '../rollup.config.js';


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
    if (watch) {
      rollup.watch(config);
    } else {
      console.log('hello')
      console.dir(config);
      console.log('hello')
      for (let conf of config) {
        await rollup.rollup(<any>conf)
      }
      this.log(`Done building.`);
    }
  }
}
