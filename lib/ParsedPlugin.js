"use strict";
var __makeTemplateObject = (this && this.__makeTemplateObject) || function (cooked, raw) {
    if (Object.defineProperty) { Object.defineProperty(cooked, "raw", { value: raw }); } else { cooked.raw = raw; }
    return cooked;
};
var __assign = (this && this.__assign) || function () {
    __assign = Object.assign || function(t) {
        for (var s, i = 1, n = arguments.length; i < n; i++) {
            s = arguments[i];
            for (var p in s) if (Object.prototype.hasOwnProperty.call(s, p))
                t[p] = s[p];
        }
        return t;
    };
    return __assign.apply(this, arguments);
};
var __spreadArrays = (this && this.__spreadArrays) || function () {
    for (var s = 0, i = 0, il = arguments.length; i < il; i++) s += arguments[i].length;
    for (var r = Array(s), k = 0, i = 0; i < il; i++)
        for (var a = arguments[i], j = 0, jl = a.length; j < jl; j++, k++)
            r[k] = a[j];
    return r;
};
Object.defineProperty(exports, "__esModule", { value: true });
/**
 * Expects js code in es7 form
 */
var lodash_1 = require("lodash");
var COMMAND_PROPS_TO_REMOVE = ['fn', 'delay', 'description', 'test', 'global', 'context', 'minConfidence', 'enterContext', 'activeDocument'];
var PLUGIN_PROPS_TO_REMOVE = ['description', 'homophones', 'version', 'authors', 'match', 'plan', 'apiVersion', 'contexts', 'niceName', 'replacements'];
var ParsedPlugin = /** @class */ (function () {
    function ParsedPlugin(j, source) {
        this.j = j;
        this.ast = j(source);
        this.exportName = this.getExportName();
        this.pluginDef = this.getPluginDef();
        this.pluginPlan = this.getPluginPlan();
    }
    ParsedPlugin.prototype.getExportName = function () {
        return this.ast
            .find(this.j.ExportDefaultDeclaration)
            .get(0)
            .node
            .declaration
            .name;
    };
    ParsedPlugin.prototype.getPluginDef = function () {
        var varDecl = this.ast.findVariableDeclarators(this.exportName);
        var i = 0;
        // there could of course be other variable declarators with 
        // the same name as the export
        var curVarDecl = varDecl.at(i);
        var propsToFind = ['niceName', 'version'];
        startover: while (curVarDecl) {
            for (var _i = 0, propsToFind_1 = propsToFind; _i < propsToFind_1.length; _i++) {
                var prop = propsToFind_1[_i];
                if (!curVarDecl.find(this.j.Property, { key: { name: prop } }).at(0).length) {
                    i++;
                    curVarDecl = varDecl.at(i);
                    continue startover;
                }
            }
            break;
        }
        return curVarDecl;
    };
    ParsedPlugin.prototype.getBackend = function () {
        // add a Plugin.languages object
        this.pluginDef
            .find(this.j.Property)
            .at(0)
            .insertAfter(this.j.property('init', this.j.identifier('languages'), this.j.template.expression(templateObject_1 || (templateObject_1 = __makeTemplateObject(["{}"], ["{}"])))));
        return this.ast.toSource();
    };
    /**
     *
     * @param matching set to true to make CS for matching CS, false for non-matching CS (only global commands)
     * @param buildForPlan
     */
    ParsedPlugin.prototype.getCS = function (matching, buildForPlan) {
        // if the plugin has a plan > 0, stub all the pageFns in plan 0 and put real pageFns in the appropriate file
        var commandsColl = this.getCommandsColl();
        var commandsObjs = this.getCommandsObjs(commandsColl);
        if (!matching) {
            // remove non global commands
            commandsObjs
                .filter(function (cmdObj) {
                var globalProp = cmdObj.value.properties.find(function (prop) { return prop.key.name === 'global'; });
                if (!globalProp || globalProp.value.value === false)
                    return true;
                return false;
            })
                .remove();
            // remaining commandsObjs
            commandsObjs = this.getCommandsObjs(commandsColl);
        }
        var commandsProps = this.getCommandsProps(commandsObjs);
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
    };
    ParsedPlugin.prototype.getVersion = function () {
        var _this = this;
        return this.pluginDef
            .find(this.j.Property, { key: { name: "version" } })
            .filter(function (x) {
            // hacky
            // dev build
            var typeA = x.parentPath.node == _this.pluginDef.get(0).node.init.properties[1].argument;
            // prod build
            var typeB = x.get(0).parentPath.parentPath.parentPath.parentPath.node == _this.pluginDef.get(0).node;
            return typeA || typeB;
        })
            .find(this.j.Literal)
            .get(0)
            .node
            .value;
    };
    /**
     * Add pageFn to commands that only have fn.
     * @param j
     * @param commandsObjs
     * @param pluginPlan
     * @returns if we should output for this plan (if there are specific commands in this level)
     */
    ParsedPlugin.prototype.replaceCmdsAbovePlan = function (commandsObjs, pluginPlan, buildForPlan) {
        var _this = this;
        var cmdsOnThisPlan = false;
        var replaced = commandsObjs
            .map(function (cmdObj) {
            var _a, _b;
            var planProp = cmdObj.value.properties.find(function (prop) { return prop.key.name === 'plan'; });
            var cmdPlan = (_b = (_a = planProp) === null || _a === void 0 ? void 0 : _a.value) === null || _b === void 0 ? void 0 : _b.value;
            var minNeededPlan = cmdPlan ? cmdPlan : pluginPlan;
            // @ts-ignore
            cmdObj.data = {
                planProp: planProp,
                cmdPlan: cmdPlan,
                minNeededPlan: minNeededPlan,
            };
            return cmdObj;
        }, this.j.Property)
            .filter(function (cmdObj) {
            // @ts-ignore
            var _a = cmdObj.data, planProp = _a.planProp, cmdPlan = _a.cmdPlan, minNeededPlan = _a.minNeededPlan;
            if (!planProp) {
                if (pluginPlan === buildForPlan)
                    cmdsOnThisPlan = true;
                else if (pluginPlan > buildForPlan)
                    return true;
            }
            else {
                if (buildForPlan === cmdPlan)
                    cmdsOnThisPlan = true;
                if (minNeededPlan > buildForPlan)
                    return true;
            }
            return false;
        })
            .map(function (cmdObj) {
            // @ts-ignore
            var minNeededPlan = cmdObj.data.minNeededPlan;
            var pageFnProp = cmdObj.value.properties.find(function (prop) { return prop.key.name === 'pageFn'; });
            if (!pageFnProp) {
                cmdObj.node.properties.push(_this.j.property('init', _this.j.identifier('pageFn'), _this.j.template.expression(templateObject_2 || (templateObject_2 = __makeTemplateObject(["()=>showNeedsUpgradeError({plan: ", "})"], ["()=>showNeedsUpgradeError({plan: ", "})"])), minNeededPlan.toString())));
            }
            return cmdObj;
        }, this.j.Property)
            .find(this.j.Property, { key: { name: "pageFn" } })
            .find(this.j.ArrowFunctionExpression)
            // @ts-ignore
            .replaceWith(function (cmdObj) { var _a; return _this.j.template.expression(templateObject_3 || (templateObject_3 = __makeTemplateObject(["()=>showNeedsUpgradeError({plan: ", "})"], ["()=>showNeedsUpgradeError({plan: ", "})"])), (_a = cmdObj.parent.parent.data) === null || _a === void 0 ? void 0 : _a.minNeededPlan.toString()); });
        // if nothing is replaced, and the highestLevel is lower than build for plan, then return false so we
        // don't build for this level (the highest level might have been 10 or 0, and already built)
        return cmdsOnThisPlan || buildForPlan === 0;
    };
    ParsedPlugin.prototype.removeLanguageCode = function () {
        // remove the languages code since it's been merged in dynMatch already
        return this.ast
            .find(this.j.ExpressionStatement, { expression: { left: { object: { object: { name: this.exportName }, property: { name: 'languages' } } } } })
            .remove();
    };
    ParsedPlugin.prototype.removeSimpleCommandProps = function (commandsProps) {
        return commandsProps
            .filter(function (x) { return COMMAND_PROPS_TO_REMOVE.includes(x.node.key.name); })
            .remove();
    };
    ParsedPlugin.prototype.replaceNonDefaultExports = function () {
        // replace non-default exports (they screw up eval)
        return this.ast
            .find(this.j.ExportNamedDeclaration)
            .replaceWith(function (x) { return x.value.declaration; });
    };
    ParsedPlugin.prototype.getTopLevelProp = function (name) {
        var _this = this;
        var topLevelProp = this.pluginDef
            .find(this.j.Property, { key: { name: name } })
            .filter(function (x) { return x.parentPath.node == _this.pluginDef.get(0).node.init.properties[1].argument; })
            .find(this.j.Literal);
        return topLevelProp.length ? topLevelProp.get(0).node.value : undefined;
    };
    ParsedPlugin.prototype.getPluginPlan = function () {
        return this.getTopLevelProp('plan') || 0;
    };
    ParsedPlugin.prototype.getCommandsColl = function () {
        return this.pluginDef
            .find(this.j.Property, { key: { name: "commands" } })
            .find(this.j.ArrayExpression)
            .at(0);
    };
    ParsedPlugin.prototype.getCommandsObjs = function (commandsColl) {
        return commandsColl.find(this.j.ObjectExpression)
            // restrict to the correct depth
            .filter(function (x) { return x.parentPath.parentPath === commandsColl.get(0).parentPath; });
    };
    ParsedPlugin.prototype.getCommandsProps = function (commandsObjs) {
        var _this = this;
        return commandsObjs.map(function (cmdPath) {
            return _this.j(cmdPath)
                .find(_this.j.Property)
                .filter(function (p) { return lodash_1.get(p, 'parentPath.parentPath.parentPath.parentPath.parentPath.value.key.name') === 'commands'; })
                .paths();
        }, this.j.Property);
    };
    ParsedPlugin.prototype.transformMatchStrs = function (commandsProps) {
        var _this = this;
        var matchProp = commandsProps
            .filter(function (x) { return x.node.type === 'Property' && x.node.key.name == 'match'; });
        // remove matchStrs but not dynamic match fns
        matchProp
            .filter(function (x) { return x.node.value.type === 'Literal' || x.node.value.type === 'ArrayExpression'; })
            .remove();
        var dynMatchProp = matchProp
            .filter(function (x) { return x.node.value && x.node.value.type === 'ObjectExpression'; });
        // remove description from dynamic match fns
        dynMatchProp
            .find(this.j.Property, { key: { name: 'description' } })
            .remove();
        var otherLangs = this.ast
            .find(this.j.MemberExpression, { object: { object: { name: this.exportName }, property: { name: 'languages' } } })
            .nodes()
            .map(function (x) { return x.property.name; });
        var langCmdsByLang = otherLangs.reduce(function (memo, lang) {
            var _a;
            return (__assign(__assign({}, memo), (_a = {}, _a[lang] = _this.ast
                .find(_this.j.AssignmentExpression, { right: { type: 'ObjectExpression' }, left: { property: { name: lang }, type: 'MemberExpression', object: { property: { name: 'languages' } } } })
                .find(_this.j.Property, { key: { name: 'commands' } }), _a)));
        }, {});
        // make dyn. match functions i18n friendly
        // mixin the other languages
        dynMatchProp.replaceWith(function (p) {
            // get dynamic match commands in other langs
            var cmdName = p.parentPath.value.filter(function (x) { return x.key.name === 'name'; })[0].value.value;
            var addLangs = otherLangs.map(function (lang) {
                var matchFn = langCmdsByLang[lang]
                    .find(_this.j.Property, { key: { value: cmdName } })
                    .find(_this.j.Property, { key: { name: 'fn' } });
                if (matchFn.length) {
                    return _this.j.property('init', _this.j.identifier(lang), matchFn.get(0).node.value);
                }
            }).filter(function (x) { return x; });
            var matchObj = __spreadArrays([_this.j.property('init', _this.j.identifier("en"), p.value.value.properties[0].value)], addLangs);
            return _this.j.property('init', _this.j.identifier('match'), _this.j.objectExpression(matchObj));
        });
    };
    // cmds array to object with cmd names as keys
    ParsedPlugin.prototype.commandArrayToObject = function (commandsObjs, commandsColl) {
        var _this = this;
        // filter out already removed nodes
        var cmdsByName = commandsObjs.nodes().filter(function (x) { return x; }).map(function (cmdPath) {
            // name for object literal without quotes
            // value for with quotes
            var nameProp = cmdPath.properties.find(function (x) { return x.key.name === 'name' || x.key.value === 'name'; });
            var name = (nameProp).value.value;
            var otherProps = cmdPath.properties.filter(function (x) { return x.key.name !== 'name' && x.key.value !== 'name'; });
            return _this.j.property('init', _this.j.literal(name), _this.j.objectExpression(otherProps));
        });
        commandsColl.replaceWith(this.j.objectExpression(cmdsByName));
    };
    ParsedPlugin.prototype.removeSimplePluginProps = function () {
        var _this = this;
        // remove simple props from Plugin
        return this.pluginDef
            .find(this.j.Property)
            // restrict to the right depth
            .filter(function (x) {
            // compatibility with diff version of recast
            var init = _this.pluginDef.get(0).parentPath.value.init;
            var prop = init.properties || init.arguments;
            return prop[1].argument === x.parentPath.parentPath.value;
        })
            .filter(function (x) { return PLUGIN_PROPS_TO_REMOVE.includes(x.node.key.name); })
            .remove();
    };
    return ParsedPlugin;
}());
exports.default = ParsedPlugin;
var templateObject_1, templateObject_2, templateObject_3;
