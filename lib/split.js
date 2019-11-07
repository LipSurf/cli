"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
var ParsedPlugin_1 = require("./ParsedPlugin");
module.exports = function (j, plans, source) {
    var parsed = new ParsedPlugin_1.default(j, source);
    var ret = {
        byPlan: [parsed.getBackend()],
        version: parsed.getVersion(),
    };
    for (var _i = 0, _a = ['matching', 'nonmatching']; _i < _a.length; _i++) {
        var type = _a[_i];
        var matching = type === 'matching';
        for (var _b = 0, plans_1 = plans; _b < plans_1.length; _b++) {
            var plan = plans_1[_b];
            // shitty, we need to reparse for each type - only adds ~20ms per parsing though (not a bottleneck)
            var curParsed = new ParsedPlugin_1.default(j, source);
            ret.byPlan.push(curParsed.getCS(matching, plan) || '');
        }
    }
    return ret;
};
