"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    Object.defineProperty(o, k2, { enumerable: true, get: function() { return m[k]; } });
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || function (mod) {
    if (mod && mod.__esModule) return mod;
    var result = {};
    if (mod != null) for (var k in mod) if (k !== "default" && Object.prototype.hasOwnProperty.call(mod, k)) __createBinding(result, mod, k);
    __setModuleDefault(result, mod);
    return result;
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.escapeQuotes = exports.getDotEnv = exports.PluginPartType = void 0;
const fs = __importStar(require("fs"));
var PluginPartType;
(function (PluginPartType) {
    PluginPartType[PluginPartType["matching"] = 0] = "matching";
    PluginPartType[PluginPartType["nonmatching"] = 1] = "nonmatching";
})(PluginPartType = exports.PluginPartType || (exports.PluginPartType = {}));
const getDotEnv = (dotEnvF) => fs
    .readFileSync(dotEnvF)
    .toString()
    .split("\n")
    .filter((x) => x)
    .reduce((memo, x) => {
    // .split('=') may not work because '=' could be present in the key
    const index = x.indexOf("=");
    const splitted = [x.slice(0, index), x.slice(index + 1)];
    return Object.assign(Object.assign({}, memo), { [splitted[0]]: splitted[1] });
}, {});
exports.getDotEnv = getDotEnv;
function escapeQuotes(str) {
    return str.replace(/"/g, '\\"');
}
exports.escapeQuotes = escapeQuotes;
