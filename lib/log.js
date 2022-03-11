"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.timedErr = exports.timedLog = void 0;
// --- hack until @lipsurf/common is available here
function padTwo(num) {
    return num.toString().padStart(2, "0");
}
// --- end hack
const _timedLog = (type) => (...msgs) => {
    const now = new Date();
    console[type](`[${padTwo(now.getHours())}:${padTwo(now.getMinutes())}:${padTwo(now.getSeconds())}]`, ...msgs);
};
exports.timedLog = _timedLog("log");
exports.timedErr = _timedLog("error");
