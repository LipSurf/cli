const importPluginBase = `import PluginBase from 'chrome-extension://lnnmjmalakahagblkkcnjkoaihlfglon/dist/modules/plugin-base.mjs';`;
const importExtensionUtil = `import ExtensionUtil from 'chrome-extension://lnnmjmalakahagblkkcnjkoaihlfglon/dist/modules/extension-util.mjs';`;
const SPLITTER = '\vLS-SPLIT';

const PART_NAMES = ['backend', 'matching.cs', 'nonmatching.cs'];

module.exports = function makeCS() {
    return {
        name: 'make-cs', // this name will show up in warnings and errors
        generateBundle(options, bundle, isWrite) {
            if (isWrite) {
                // files can likely be removed from the bundle
                const keys = Object.keys(bundle);
                const whitelistedKeys = [];

                for (let plan of [0, 10, 20]) {
                    const matchingFilename = keys.find(x => x.includes(`${plan}.matching.`));
                    const plugin = matchingFilename.split('.')[0];
                    const [backend, matchingCS, nonMatchingCS] = PART_NAMES.map(partName => {
                        if (partName !== 'backend')
                            partName = `${plan}.${partName}`;
                        let fullPart = bundle[`${plugin}.${partName}.resolved.js`].code;
                        // also make sure it's not blank
                        if (partName.includes('.cs') && fullPart.trim())
                            // wrap in IIFE and take out export (not valid for eval)
                            fullPart = `allPlugins.${plugin} = (() => { ${fullPart.replace('export default', 'return')} })()`
                        return fullPart.trim();
                    });

                    if (plan === 0 || !(matchingCS === '' && nonMatchingCS === '')) {
                        console.log('whitelisting', matchingFilename, matchingCS.substr(0, 10).length, nonMatchingCS.substr(0, 10).length)
                        whitelistedKeys.push(matchingFilename);
                        bundle[matchingFilename].code = importPluginBase
                                + importExtensionUtil
                                + backend
                                + SPLITTER
                                + matchingCS
                                + SPLITTER
                                + nonMatchingCS;
                        bundle[matchingFilename].fileName = `${plugin}.${plan}.ls`;
                    }
                }
                bundle = Object.keys(bundle)
                    .filter(key => whitelistedKeys.includes(key))
                    .reduce((obj, key) => {
                        obj[key] = bundle[key];
                        return obj;
                    }, {});
            }
        },
    };
}
