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
import { get } from 'lodash';
import { JSCodeshift, Identifier, Literal, Property, ObjectProperty, ObjectExpression, VariableDeclarator, ArrayExpression, } from 'jscodeshift';
import { Collection } from 'jscodeshift/src/Collection';

interface FileInfo {
    path: string;
    source: string;
}

const COMMAND_PROPS_TO_REMOVE = ['fn', 'delay', 'description', 'test', 'global', 'context', 'minConfidence', 'enterContext'];
const PLUGIN_PROPS_TO_REMOVE = ['description', 'homophones', 'version', 'authors', 'match', 'plan', 'apiVersion', 'contexts', 'niceName'];
const PLANS = [0, 10, 20];

module.exports = function (fileInfo: FileInfo, api: JSCodeshift, options) {
    const pPath = path.parse(fileInfo.path);
    const pluginId = pPath.name.split('.')[0];
    const j: JSCodeshift = api.jscodeshift;

    makeBackend(fileInfo, api, options);

    // matching cs
    for (let plan of PLANS) {
        fs.writeFileSync(`dist/${pluginId}.${plan}.matching.cs.js`, makeMatchingCS(j, fileInfo.source, plan) || '');
        fs.writeFileSync(`dist/${pluginId}.${plan}.nonmatching.cs.js`, makeNonMatchingCS(j, fileInfo.source, plan) || '');
    }
};

function getExportNameAndPluginDef(j: JSCodeshift, ast: Collection<any>): [string, Collection<VariableDeclarator>] {
    const exportName = ast
            .find(j.ExportDefaultDeclaration)
            .get(0)
            .node
            .declaration
            .name
            ;
    return [exportName, ast
            .findVariableDeclarators(exportName)
            .at(0)];
}

function getPluginPlan(j: JSCodeshift, pluginDef: Collection<VariableDeclarator>): number {
    const plan = pluginDef
        .find(j.Property, { key: { name: `plan` }})
        .filter(x => x.parentPath.node == pluginDef.get(0).node.init.properties[1].argument)
        .find(j.Literal)
        ;
    return plan.length ? plan.get(0).node.value : 0;
}

function getCommandsColl(j: JSCodeshift, pluginDef: Collection<VariableDeclarator>): Collection<ArrayExpression> {
    return pluginDef
        .find(j.Property, { key: { name: `commands` } })
        .find(j.ArrayExpression)
        .at(0)
        ;
}

function getCommandsObjs(j: JSCodeshift, commandsColl: Collection<ArrayExpression>): Collection<ObjectExpression> {
    return commandsColl.find(j.ObjectExpression)
        // restrict to the correct depth
        .filter(x => x.parentPath.parentPath === commandsColl.get(0).parentPath)
        ;
}

function getCommandsProps(j: JSCodeshift, commandsObjs: Collection<ObjectExpression>): Collection<Property> {
    return commandsObjs.map(cmdPath =>
        j(cmdPath)
            .find(j.Property)
            .filter(p => get(p, 'parentPath.parentPath.parentPath.parentPath.parentPath.value.key.name') === 'commands')
            .paths()
        , j.Property)
    ;
}

function transformMatchStrs(j: JSCodeshift, exportName: string, csAST: Collection<any>, commandsProps: Collection<Property>) {
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
    
    const otherLangs = csAST
        .find(j.MemberExpression, { object: { object: { name: exportName }, property: { name: 'languages' } } })
        .nodes()
        .map(x => (<Identifier>x.property).name)
    
    const langCmdsByLang = otherLangs.reduce((memo, lang) => 
        ({...memo, 
            ...{[lang]: csAST
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
    
}

// cmds array to object with cmd names as keys
function commandArrayToObject(j: JSCodeshift, commandsObjs: Collection<ObjectExpression>, commandsColl: Collection<ArrayExpression>) {
    // filter out already removed nodes
    const cmdsByName = commandsObjs.nodes().filter(x => x).map(cmdPath => {
        let nameProp = <ObjectProperty>cmdPath.properties.find(x => (<Identifier>(<ObjectProperty>x).key).name === 'name');
        let name = <string>(<Literal>(nameProp).value).value;
        let otherProps = cmdPath.properties.filter(x => (<Identifier>(<ObjectProperty>x).key).name !== 'name');
        return j.property('init', j.literal(name), j.objectExpression(otherProps));
    });
    commandsColl.replaceWith(j.objectExpression(cmdsByName));
}

function removeSimplePluginProps(j: JSCodeshift, pluginDef: Collection<VariableDeclarator>) {
    // remove simple props from Plugin
    return pluginDef
        .find(j.Property)
        // restrict to the right depth
        .filter(x => {
            // compatibility with diff version of recast
            const init = pluginDef.get(0).parentPath.value.init;
            const prop = init.properties || init.arguments;
                
            return prop[1].argument === x.parentPath.parentPath.value;
        })
        .filter(x => PLUGIN_PROPS_TO_REMOVE.includes((<Identifier>x.node.key).name))
        .remove()
        ;

}

// TODO: needs to not look at pluginId... but whatever the plugin was imported as since it's imported as a default it can have any name
function removeLanguageCode(j: JSCodeshift, exportName: string, ast: Collection<any>) {
    // remove the languages code since it's been merged in dynMatch already
    return ast
        .find(j.ExpressionStatement, { expression: { left: { object: { object: { name: exportName }, property: {name: 'languages' } } } } })
        .remove()

}
function removeSimpleCommandProps(j: JSCodeshift, commandsProps: Collection<Property>) {
    return commandsProps
        .filter(x => COMMAND_PROPS_TO_REMOVE.includes((<Identifier>x.node.key).name))
        .remove()
        ;
}

function replaceNonDefaultExports(j: JSCodeshift, ast: Collection<any>) {
    // replace non-default exports (they screw up eval)
    return ast
        .find(j.ExportNamedDeclaration)
        .replaceWith(x => x.value.declaration)

}

/**
 * Add pageFn to commands that only have fn.
 * @param j 
 * @param commandsObjs 
 * @param pluginPlan 
 * @returns if we should output for this plan (if there are specific commands in this level)
 */
function replaceCmdsAbovePlan(j: JSCodeshift, commandsObjs: Collection<ObjectExpression>, pluginPlan: number, buildForPlan: number): boolean {
    let cmdsOnThisPlan: boolean = false;
    const replaced = commandsObjs
        .filter(cmdObj => {
            const planProp = <Property>cmdObj.value.properties.find((prop: Property) => (<Identifier>prop.key).name === 'plan');
            if (!planProp) {
                if (pluginPlan === buildForPlan)
                    cmdsOnThisPlan = true;
                else if (pluginPlan > buildForPlan) 
                    return true;
            } else {
                const cmdPlan  = <number>(<Literal>planProp.value).value;
                if (buildForPlan === cmdPlan)
                    cmdsOnThisPlan = true;
                if (Math.max(pluginPlan, cmdPlan) > buildForPlan)
                    return true;
            }
        })
        .map(cmdObj => {
            const pageFnProp = <Property>cmdObj.value.properties.find((prop: Property) => (<Identifier>prop.key).name === 'pageFn');
            if (!pageFnProp) {
                cmdObj.node.properties.push(j.property('init', j.identifier('pageFn'), j.template.expression`showNeedsUpgradeError`));
            }
            return cmdObj;
        }, j.Property)
        .find(j.Property, { key: { name: `pageFn` } })
        .find(j.ArrowFunctionExpression)
        ;
    replaced.replaceWith(j.template.expression`showNeedsUpgradeError`);
    
    // if nothing is replaced, and the highestLevel is lower than build for plan, then return false so we
    // don't build for this level (the highest level might have been 10 or 0, and already built)
    return cmdsOnThisPlan || buildForPlan === 0;
}

function makeNonMatchingCS(j: JSCodeshift, source: string, buildForPlan: number): string {
    const csAST = j(source);
    const [exportName, pluginDef] = getExportNameAndPluginDef(j, csAST);
    const commandsColl = getCommandsColl(j, pluginDef);
    let commandsObjs = getCommandsObjs(j, commandsColl);

    // remove non global commands
    commandsObjs = commandsObjs
        .filter(cmdObj => {
            const globalProp = <Property>cmdObj.value.properties.find((prop: Property) => (<Identifier>prop.key).name === 'global');
            if (!globalProp || (<Literal>globalProp.value).value === false)
                return true;
        })
        .remove()

    const commandsProps = getCommandsProps(j, commandsObjs);

    // if there's no commands, this plugin can be blank
    if (commandsProps.size() === 0) 
        return '';

    // if the plugin has a plan > 0, stub all the pageFns in plan 0 and put real pageFns in the appropriate file
    const pluginPlan = getPluginPlan(j, pluginDef);
    removeSimplePluginProps(j, pluginDef);

    // 0 level (free) plugin always exists so user can get upgrade message
    if (replaceCmdsAbovePlan(j, commandsObjs, pluginPlan, buildForPlan)) {
        removeSimpleCommandProps(j, commandsProps);
        transformMatchStrs(j, exportName, csAST, commandsProps);
        commandArrayToObject(j, commandsObjs, commandsColl);
        removeLanguageCode(j, exportName, csAST);
        replaceNonDefaultExports(j, csAST);

        return csAST.toSource();
    } 
}

function makeMatchingCS(j: JSCodeshift, source: string, buildForPlan: number): string {
    const csAST = j(source);
    const [exportName, pluginDef] = getExportNameAndPluginDef(j, csAST);

    // if the plugin has a plan > 0, stub all the pageFns in plan 0 and put real pageFns in the appropriate file
    const pluginPlan = getPluginPlan(j, pluginDef);
    console.log('plugin plan ', pluginPlan);

    removeSimplePluginProps(j, pluginDef);

    const commandsColl = getCommandsColl(j, pluginDef);
    const commandsObjs = getCommandsObjs(j, commandsColl);
    const commandsProps = getCommandsProps(j, commandsObjs);

    // 0 level (free) plugin always exists so user can get upgrade message
    if (replaceCmdsAbovePlan(j, commandsObjs, pluginPlan, buildForPlan)) {
        removeSimpleCommandProps(j, commandsProps);
        transformMatchStrs(j, exportName, csAST, commandsProps);
        commandArrayToObject(j, commandsObjs, commandsColl);
        removeLanguageCode(j, exportName, csAST);
        replaceNonDefaultExports(j, csAST);

        return csAST.toSource();
    }
}

/**
 * 
 */
function makeBackend(fileInfo: FileInfo, api: JSCodeshift, options) {
    const pPath = path.parse(fileInfo.path);
    const plugin = pPath.name.split('.')[0];
    const j: JSCodeshift = api.jscodeshift;

    const backendAST = j(fileInfo.source);
    fs.writeFileSync(`dist/${plugin}.backend.js`, `${backendAST.toSource()}`);
}
