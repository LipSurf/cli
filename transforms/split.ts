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
const PLUGIN_PROPS_TO_REMOVE = ['description', 'homophones', 'version', 'authors', 'match', 'plan', 'apiVersion', 'contexts', 'niceName', 'replacements'];
const PLANS = [0, 10, 20];

module.exports = function (fileInfo: FileInfo, api: JSCodeshift, options) {
    const pPath = path.parse(fileInfo.path);
    const pluginId = pPath.name.split('.')[0];
    const j: JSCodeshift = api.jscodeshift;

    for (let plan of PLANS) {
        for (let type of ['matching', 'nonmatching']) {
            // shitty, we need to reparse for each type
            const parsed = new ParsedPlugin(j, fileInfo.source);
            const matching = type === 'matching';
            const version = parsed.getVersion();
            fs.writeFileSync(`dist/${pluginId}.${version.replace(/\./g, '-')}.${plan}.${type}.cs.js`, parsed.getCS(matching, plan) || '');
        }
    }
    const parsed = new ParsedPlugin(j, fileInfo.source);
    const version = parsed.getVersion();
    fs.writeFileSync(`dist/${pluginId}.${version.replace(/\./g, '-')}.backend.js`, parsed.getBackend() || '');
};



class ParsedPlugin {
    private ast: any;
    private pluginDef: Collection<VariableDeclarator>;
    private exportName: string;
    
    constructor(private j: JSCodeshift, source: string) {
        this.ast = j(source);
        this.exportName = this.getExportName();
        this.pluginDef = this.getPluginDef();
    }

    private getExportName() {
        return this.ast
                .find(this.j.ExportDefaultDeclaration)
                .get(0)
                .node
                .declaration
                .name
                ;
    }

    private getPluginDef(): Collection<VariableDeclarator> {
        return this.ast
                .findVariableDeclarators(this.exportName)
                .at(0);
    }

    getBackend() {
        // add a Plugin.languages object
        this.pluginDef
            .find(this.j.Property)
            .at(0)
            .insertAfter(this.j.property('init', this.j.identifier('languages'), this.j.template.expression`{}`))
            ;
        return this.ast.toSource();
    }

    /**
     * 
     * @param matching set to true to make CS for matching CS, false for non-matching CS (only global commands)
     * @param buildForPlan 
     */
    getCS(matching: boolean, buildForPlan: number): string {
        // if the plugin has a plan > 0, stub all the pageFns in plan 0 and put real pageFns in the appropriate file
        const pluginPlan = this.getPluginPlan();
        console.log('plugin plan ', pluginPlan);

        const commandsColl = this.getCommandsColl();
        let commandsObjs = this.getCommandsObjs(commandsColl);

        if (!matching) {
            // remove non global commands
            commandsObjs
                .filter(cmdObj => {
                    const globalProp = <Property>cmdObj.value.properties.find((prop: Property) => (<Identifier>prop.key).name === 'global');
                    if (!globalProp || (<Literal>globalProp.value).value === false)
                        return true;
                })
                .remove()

            // remaining commandsObjs
            commandsObjs = this.getCommandsObjs(commandsColl)
        }

        const commandsProps = this.getCommandsProps(commandsObjs);

        // if there's no commands, and no init and destroy this plugin can be blank
        if (commandsProps.size() === 0 && !this.getTopLevelProp('init') && !this.getTopLevelProp('destroy')) 
            return '';

        this.removeSimplePluginProps();

        // 0 level (free) plugin always exists so user can get upgrade message
        if (this.replaceCmdsAbovePlan(commandsObjs, pluginPlan, buildForPlan)) {
            this.removeSimpleCommandProps(commandsProps);
            this.transformMatchStrs(commandsProps);
            this.commandArrayToObject(commandsObjs, commandsColl);
            this.removeLanguageCode();
            this.replaceNonDefaultExports();

            return this.ast.toSource();
        }
    }

    getVersion() {
        return this.pluginDef
            .find(this.j.Property, { key: { name: `version` }})
            .filter(x => x.parentPath.node == this.pluginDef.get(0).node.init.properties[1].argument)
            .find(this.j.Literal)
            .get(0)
            .node
            .value
            ;
    }

    /**
     * Add pageFn to commands that only have fn.
     * @param j 
     * @param commandsObjs 
     * @param pluginPlan 
     * @returns if we should output for this plan (if there are specific commands in this level)
     */
    private replaceCmdsAbovePlan(commandsObjs: Collection<ObjectExpression>, pluginPlan: number, buildForPlan: number): boolean {
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
                    cmdObj.node.properties.push(this.j.property('init', this.j.identifier('pageFn'), this.j.template.expression`showNeedsUpgradeError`));
                }
                return cmdObj;
            }, this.j.Property)
            .find(this.j.Property, { key: { name: `pageFn` } })
            .find(this.j.ArrowFunctionExpression)
            ;
        replaced.replaceWith(this.j.template.expression`showNeedsUpgradeError`);
        
        // if nothing is replaced, and the highestLevel is lower than build for plan, then return false so we
        // don't build for this level (the highest level might have been 10 or 0, and already built)
        return cmdsOnThisPlan || buildForPlan === 0;
    }

    private removeLanguageCode() {
        // remove the languages code since it's been merged in dynMatch already
        return this.ast
            .find(this.j.ExpressionStatement, { expression: { left: { object: { object: { name: this.exportName }, property: {name: 'languages' } } } } })
            .remove()
    }

    private removeSimpleCommandProps(commandsProps: Collection<Property>) {
        return commandsProps
            .filter(x => COMMAND_PROPS_TO_REMOVE.includes((<Identifier>x.node.key).name))
            .remove()
            ;
    }

    private replaceNonDefaultExports() {
        // replace non-default exports (they screw up eval)
        return this.ast
            .find(this.j.ExportNamedDeclaration)
            .replaceWith(x => x.value.declaration)

    }

    private getTopLevelProp(name: string) {
        const topLevelProp = this.pluginDef
            .find(this.j.Property, { key: { name }})
            .filter(x => x.parentPath.node == this.pluginDef.get(0).node.init.properties[1].argument)
            .find(this.j.Literal)
            ;
        return topLevelProp.length ? topLevelProp.get(0).node.value : undefined;
    }

    private getPluginPlan(): number {
        return this.getTopLevelProp('plan') || 0;
    }

    private getCommandsColl(): Collection<ArrayExpression> {
        return this.pluginDef
            .find(this.j.Property, { key: { name: `commands` } })
            .find(this.j.ArrayExpression)
            .at(0)
            ;
    }

    private getCommandsObjs(commandsColl: Collection<ArrayExpression>): Collection<ObjectExpression> {
        return commandsColl.find(this.j.ObjectExpression)
            // restrict to the correct depth
            .filter(x => x.parentPath.parentPath === commandsColl.get(0).parentPath)
            ;
    }

    private getCommandsProps(commandsObjs: Collection<ObjectExpression>): Collection<Property> {
        return commandsObjs.map(cmdPath =>
            this.j(cmdPath)
                .find(this.j.Property)
                .filter(p => get(p, 'parentPath.parentPath.parentPath.parentPath.parentPath.value.key.name') === 'commands')
                .paths()
            , this.j.Property)
        ;
    }

    private transformMatchStrs(commandsProps: Collection<Property>) {
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
            .find(this.j.Property, { key: { name: 'description' } })
            .remove()
            ;
        
        const otherLangs = this.ast
            .find(this.j.MemberExpression, { object: { object: { name: this.exportName }, property: { name: 'languages' } } })
            .nodes()
            .map(x => (<Identifier>x.property).name)
        
        const langCmdsByLang = otherLangs.reduce((memo, lang) => 
            ({...memo, 
                ...{[lang]: this.ast
                    .find(this.j.AssignmentExpression, { right: { type: 'ObjectExpression' }, left: { property: {name: lang}, type: 'MemberExpression', object: { property: { name: 'languages' }} } })
                    .find(this.j.Property, { key: { name: 'commands' } })
                }
            }), {});
        
        // make dyn. match functions i18n friendly
        // mixin the other languages
        dynMatchProp.replaceWith(p => {
            // get dynamic match commands in other langs
            const cmdName = p.parentPath.value.filter(x => x.key.name === 'name')[0].value.value;
            const addLangs = otherLangs.map(lang => {
                let matchFn = langCmdsByLang[lang]
                    .find(this.j.Property, {key: {value: cmdName}})
                    .find(this.j.Property, {key: {name: 'fn'}})
                    ;
                if (matchFn.length) {
                    return this.j.property('init', this.j.identifier(lang), matchFn.get(0).node.value);
                }
            }).filter(x => x);
            const matchObj = [this.j.property('init', this.j.identifier("en"), (<Property>(<ObjectExpression>p.value.value).properties[0]).value), ...addLangs];
            return this.j.property('init', this.j.identifier('match'), this.j.objectExpression(matchObj));
        });
        
    }

    // cmds array to object with cmd names as keys
    private commandArrayToObject(commandsObjs: Collection<ObjectExpression>, commandsColl: Collection<ArrayExpression>) {
        // filter out already removed nodes
        const cmdsByName = commandsObjs.nodes().filter(x => x).map(cmdPath => {
            let nameProp = <ObjectProperty>cmdPath.properties.find(x => (<Identifier>(<ObjectProperty>x).key).name === 'name');
            let name = <string>(<Literal>(nameProp).value).value;
            let otherProps = cmdPath.properties.filter(x => (<Identifier>(<ObjectProperty>x).key).name !== 'name');
            return this.j.property('init', this.j.literal(name), this.j.objectExpression(otherProps));
        });
        commandsColl.replaceWith(this.j.objectExpression(cmdsByName));
    }

    private removeSimplePluginProps() {
        // remove simple props from Plugin
        return this.pluginDef
            .find(this.j.Property)
            // restrict to the right depth
            .filter(x => {
                // compatibility with diff version of recast
                const init = this.pluginDef.get(0).parentPath.value.init;
                const prop = init.properties || init.arguments;
                    
                return prop[1].argument === x.parentPath.parentPath.value;
            })
            .filter(x => PLUGIN_PROPS_TO_REMOVE.includes((<Identifier>x.node.key).name))
            .remove()
            ;

    }
}