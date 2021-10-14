#!/usr/bin/env node
const beautify = require("js-beautify").js;
const { PLUGIN_SPLIT_SEQ } = require("@lipsurf/common/constants.cjs");
const fs = require("fs");

for (const name of process.argv.slice(2)) {
  fs.readFile(name, "utf8", function (err, data) {
    if (err) {
      throw err;
    }
    const splitted = data.split(PLUGIN_SPLIT_SEQ);
    const parts = splitted.map((x) =>
      beautify(x, { indent_size: 2, space_in_empty_paren: true })
    );
    fs.writeFileSync(name, parts.join(`\n${PLUGIN_SPLIT_SEQ}\n`));
  });
}
