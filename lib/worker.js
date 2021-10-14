"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const transform_1 = require("./transform");
process.on("message", (msg) => {
    // console.log("Message from parent:", msg);
    (0, transform_1.transformJSToPlugin)(...msg)
        .then(() => {
        process.exit(0);
    })
        .catch(() => {
        process.exit(1);
    });
});
