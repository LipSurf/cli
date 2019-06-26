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
*    * TODO: remove pageFn of plan > 0
* Backend: 
*    * no need to make more space-efficient because the store watchers/mutators
*      only take what they need.
*/
import * as path from 'path';
import * as fs from 'fs';
import { get } from 'lodash';
import { JSCodeshift, Identifier, Literal, Property, ObjectProperty, ObjectExpression, } from 'jscodeshift';

interface FileInfo {
    path: string;
    source: string;
}

const COMMAND_PROPS_TO_REMOVE = ['fn', 'delay', 'description', 'test', 'global', 'context'];
const PLUGIN_PROPS_TO_REMOVE = ['description', 'homophones', 'version', 'authors', 'match'];

module.exports = function (fileInfo: FileInfo, api: JSCodeshift, options) {
    const pPath = path.parse(fileInfo.path);
    const plugin = pPath.name.split('.')[0];
    const j: JSCodeshift = api.jscodeshift;

    makeBackend(fileInfo, api, options);

    const matchingCSAST = j(fileInfo.source);
    const exportName = matchingCSAST
            .find(j.ExportDefaultDeclaration)
            .get(0)
            .node
            .declaration
            .name
            ;

    const pluginDef = matchingCSAST
        .findVariableDeclarators(exportName)
        .at(0)
        ;

    const commandsColl = pluginDef
        .find(j.Property, { key: { name: `commands` } })
        .find(j.ArrayExpression)
        .at(0)
        ;

    const commandsObjs = commandsColl
        .find(j.ObjectExpression)
        // restrict to the correct depth
        .filter(x => x.parentPath.parentPath === commandsColl.get(0).parentPath)
        ;

    const commandsProps = commandsObjs
        .map(cmdPath =>
            j(cmdPath)
                .find(j.Property)
                .filter(p => get(p, 'parentPath.parentPath.parentPath.parentPath.parentPath.value.key.name') === 'commands')
                .paths()
            , j.Property)
        ;

    // remove simple props from commands
    commandsProps
        .filter(x => COMMAND_PROPS_TO_REMOVE.includes((<Identifier>x.node.key).name))
        .remove()
        ;

    const matchProp = commandsProps
        .filter(x => x.node.type === 'Property' && (<Identifier>x.node.key).name == 'match')
        ;

    // remove matchStrs but not dynamic match fns
    matchProp
        .filter(x => x.node.value.type === 'Literal' || x.node.value.type === 'ArrayExpression')
        .remove()
        ;

    const dynMatchProp = matchProp
        .filter(x => x.node.value && x.node.value.type === 'ObjectExpression')
        ;

    // remove description from dynamic match fns
    dynMatchProp
        .find(j.Property, { key: { name: 'description' } })
        .remove()
        ;
    
    const otherLangs = matchingCSAST
        .find(j.MemberExpression, { object: { object: { name: plugin }, property: {name: 'languages' } } })
        .nodes()
        .map(x => (<Identifier>x.property).name)
    
    const langCmdsByLang = otherLangs.reduce((memo, lang) => 
        ({...memo, 
            ...{[lang]: matchingCSAST
                .find(j.AssignmentExpression, { right: { type: 'ObjectExpression' }, left: { property: {name: lang}, type: 'MemberExpression', object: { property: { name: 'languages' }} } })
                .find(j.Property, { key: { name: 'commands' } })
            }
        }), {});
    
    // make dyn. match functions i18n friendly
    // mixin the other languages
    dynMatchProp.replaceWith(p => {
        // get dynamic match commands in other langs
        const cmdName = p.parentPath.value.filter(x => x.key.name === 'name')[0].value.value;
        const addLangs = otherLangs.map(lang => {
            let matchFn = langCmdsByLang[lang]
                .find(j.Property, {key: {value: cmdName}})
                .find(j.Property, {key: {name: 'fn'}})
                ;
            if (matchFn.length) {
                return j.property('init', j.identifier(lang), matchFn.get(0).node.value);
            }
        }).filter(x => x);
        const matchObj = [j.property('init', j.identifier("en"), (<Property>(<ObjectExpression>p.value.value).properties[0]).value), ...addLangs];
        return j.property('init', j.identifier('match'), j.objectExpression(matchObj));
    });
    
    // cmds array to object with cmd names as keys
    const cmdsByName = commandsObjs.nodes().map(cmdPath => {
        let nameProp = <ObjectProperty>cmdPath.properties.find(x => (<Identifier>(<ObjectProperty>x).key).name === 'name');
        let name = <string>(<Literal>(nameProp).value).value;
        let otherProps = cmdPath.properties.filter(x => (<Identifier>(<ObjectProperty>x).key).name !== 'name');
        return j.property('init', j.literal(name), j.objectExpression(otherProps));
    });
    commandsColl.replaceWith(j.objectExpression(cmdsByName));

    // replace non-default exports (they screw up eval)
    matchingCSAST
        .find(j.ExportNamedDeclaration)
        .replaceWith(x => x.value.declaration)

    // remove the languages code since it's been merged in dynMatch already
    matchingCSAST
        .find(j.ExpressionStatement, { expression: { left: { object: { object: { name: plugin }, property: {name: 'languages' } } } } })
        .remove()

    // matching cs
    fs.writeFileSync(`dist/${plugin}.matching.cs.js`, `${matchProp.toSource()}`);
};

/**
 * 
 */
function makeBackend(fileInfo: FileInfo, api: JSCodeshift, options) {
    const pPath = path.parse(fileInfo.path);
    const plugin = pPath.name.split('.')[0];
    const j: JSCodeshift = api.jscodeshift;

    const backendAST = j(fileInfo.source);
    console.log('writing backend');
    fs.writeFileSync(`dist/${plugin}.backend.js`, `${backendAST.toSource()}`);
}
