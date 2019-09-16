/**
* Split the plugin into a frontend/backend. Frontend needs to be
* loaded on every page, so it should be lightweight. 
* 
* We don't operate on the eval'd plugin js because that got complicated
* to import here since async import is not handled natively yet.
* Later, we might explore this possibility again for correctness/simplicity
* for computed/dynamic top-level values 
* (eg. Plugin.languages.ru = ..., later Plugin.languages.ru.commands = (morphed))
* we don't operate solely on eval'd js, because it wouldn't allow certain things
* like abstracting away PluginBase with {...PluginBase, { ...(plugin code)}}
* 
* For frontend:
*    * remove homophones
*    * remove commands.match,description,fn,test,delay,nice,context,enterContext,plan
*    * replace non-default exports
*    * TODO: remove commands that have no pageFn or dynamic match
* Backend: 
*    * no need to make more space-efficient because the store watchers/mutators
*      only take what they need.
*/
import { JSCodeshift, } from 'jscodeshift';
import ParsedPlugin from './ParsedPlugin';

interface SplitPlugin {
    version: string;
    byPlan: string[];
}

module.exports = function (j: JSCodeshift, plans: number[], source: string): SplitPlugin {
    const parsed = new ParsedPlugin(j, source);
    const ret: Partial<SplitPlugin> = {
        byPlan: [parsed.getBackend()],
    };
    for (let type of ['matching', 'nonmatching']) {
        const matching = type === 'matching';
        for (let plan of plans) {
            // shitty, we need to reparse for each type - how can we avoid
            let curParsed = new ParsedPlugin(j, source);
            if (!ret.version)
                ret.version = curParsed.getVersion();
            ret.byPlan!.push(curParsed.getCS(matching, plan) || '');
        }
    }
    return <SplitPlugin>ret;
};


