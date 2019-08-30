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
import * as path from 'path';
import * as fs from 'fs';
import { JSCodeshift, } from 'jscodeshift';
import ParsedPlugin from './ParsedPlugin';

interface FileInfo {
    path: string;
    source: string;
}

const PLANS = [0, 10, 20];

module.exports = function (fileInfo: FileInfo, api: JSCodeshift, options) {
    const pPath = path.parse(fileInfo.path);
    const pluginId = pPath.name.split('.')[0];
    const j: JSCodeshift = api.jscodeshift;
    let parsed = new ParsedPlugin(j, fileInfo.source);
    const version = parsed.getVersion();
    const firstPartOfPath = `${pPath.dir}/${pluginId}.${version.replace(/\./g, '-')}`;

    for (let plan of PLANS) {
        for (let type of ['matching', 'nonmatching']) {
            // shitty, we need to reparse for each type
            parsed = new ParsedPlugin(j, fileInfo.source);
            const matching = type === 'matching';
            fs.writeFileSync(`${firstPartOfPath}.${plan}.${type}.cs.js`, parsed.getCS(matching, plan) || '');
        }
    }
    parsed = new ParsedPlugin(j, fileInfo.source);
    fs.writeFileSync(`${firstPartOfPath}.backend.js`, parsed.getBackend() || '');
};


