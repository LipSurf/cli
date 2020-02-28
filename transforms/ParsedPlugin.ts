/**
 * Expects js code in es7 form
 */
import { get } from 'lodash';
import { JSCodeshift, Identifier, Literal, Property, ObjectProperty, ObjectExpression, VariableDeclarator, ArrayExpression, ASTNode, } from 'jscodeshift';
import { Collection } from 'jscodeshift/src/Collection';

const COMMAND_PROPS_TO_REMOVE = ['fn', 'delay', 'description', 'test', 'global', 'context', 'minConfidence', 'enterContext', 'activeDocument'];
const PLUGIN_PROPS_TO_REMOVE = ['description', 'homophones', 'version', 'authors', 'match', 'plan', 'apiVersion', 'contexts', 'niceName', 'replacements'];

export default class ParsedPlugin {
    private ast: any;
    private pluginDef: Collection<VariableDeclarator>;
    private exportName: string;
    private pluginPlan: number;
    
    constructor(private j: JSCodeshift, source: string) {
        this.ast = j(source);
        this.exportName = this.getExportName();
        this.pluginDef = this.getPluginDef();
        this.pluginPlan = this.getPluginPlan();
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
        const varDecl = this.ast.findVariableDeclarators(this.exportName);
        let i = 0;
        // there could of course be other variable declarators with 
        // the same name as the export
        let curVarDecl = varDecl.at(i);
        const propsToFind = ['niceName', 'version'];
        startover:
        while (curVarDecl) {
            for (let prop of propsToFind) {
                if (!curVarDecl.find(this.j.Property, { key: { name: prop }}).at(0).length) {
                    i++;
                    curVarDecl = varDecl.at(i);
                    continue startover;
                }
            }
            break;
        }
        return curVarDecl;
    }

    getBackend(): string {
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
    getCS(matching: boolean, buildForPlan: number): string|undefined {
        // if the plugin has a plan > 0, stub all the pageFns in plan 0 and put real pageFns in the appropriate file
        const commandsColl = this.getCommandsColl();
        let commandsObjs = this.getCommandsObjs(commandsColl);

        if (!matching) {
            // remove non global commands
            commandsObjs
                .filter(cmdObj => {
                    const globalProp = (<Property[]>cmdObj.value.properties).find((prop: Property) => (<Identifier>prop.key).name === 'global');
                    if (!globalProp || (<Literal>globalProp.value).value === false)
                        return true;
                    return false;
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
        if (this.replaceCmdsAbovePlan(commandsObjs, this.pluginPlan, buildForPlan)) {
            this.removeSimpleCommandProps(commandsProps);
            this.transformMatchStrs(commandsProps);
            this.commandArrayToObject(commandsObjs, commandsColl);
            this.removeLanguageCode();
            this.replaceNonDefaultExports();

            return this.ast.toSource();
        }
    }

    getVersion(): string {
        return this.pluginDef
            .find(this.j.Property, { key: { name: `version` }})
            .filter(x => {
                // hacky
                // dev build
                const typeA = x.parentPath.node == this.pluginDef.get(0).node.init.properties[1].argument;
                // prod build
                const typeB = x.get(0).parentPath.parentPath.parentPath.parentPath.node == this.pluginDef.get(0).node;
                return typeA || typeB;
            })
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
            .map(cmdObj => {
                const planProp = (<Property[]>cmdObj.value.properties).find((prop: Property) => (<Identifier>prop.key).name === 'plan');
                const cmdPlan  = <number>(<Literal>planProp?.value)?.value;
                const minNeededPlan = cmdPlan ? cmdPlan : pluginPlan;
                // @ts-ignore
                cmdObj.data = {
                    planProp,
                    cmdPlan,
                    minNeededPlan,
                };
                return cmdObj
            }, this.j.Property)
            .filter(cmdObj => {
                // @ts-ignore
                const {planProp, cmdPlan, minNeededPlan} = cmdObj.data;
                if (!planProp) {
                    if (pluginPlan === buildForPlan)
                        cmdsOnThisPlan = true;
                    else if (pluginPlan > buildForPlan) 
                        return true;
                } else {
                    if (buildForPlan === cmdPlan)
                        cmdsOnThisPlan = true;
                    if (minNeededPlan > buildForPlan)
                        return true;
                }
                return false;
            })
            .map(cmdObj => {
                // @ts-ignore
                const { minNeededPlan } = cmdObj.data;
                const pageFnProp = (<Property[]>cmdObj.value.properties).find((prop: Property) => (<Identifier>prop.key).name === 'pageFn');
                if (!pageFnProp) {
                    cmdObj.node.properties.push(this.j.property('init', this.j.identifier('pageFn'), this.j.template.expression`()=>showNeedsUpgradeError({plan: ${minNeededPlan.toString()}})`));
                }
                return cmdObj;
            }, this.j.Property)
            .find(this.j.Property, { key: { name: `pageFn` } })
            .find(this.j.ArrowFunctionExpression)
            // @ts-ignore
            .replaceWith(cmdObj => this.j.template.expression`()=>showNeedsUpgradeError({plan: ${cmdObj.parent.parent.data?.minNeededPlan.toString()}})`)
            ;
        
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
            // name for object literal without quotes
            // value for with quotes
            let nameProp = <ObjectProperty>cmdPath.properties.find(x => (<Identifier>(<ObjectProperty>x).key).name === 'name' || (<Literal>(<ObjectProperty>x).key).value === 'name');
            let name = <string>(<Literal>(nameProp).value).value;
            let otherProps = cmdPath.properties.filter(x => (<Identifier>(<ObjectProperty>x).key).name !== 'name' && (<Literal>(<ObjectProperty>x).key).value !== 'name');
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