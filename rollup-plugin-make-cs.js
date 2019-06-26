const importPluginBase = `import PluginBase from 'chrome-extension://lnnmjmalakahagblkkcnjkoaihlfglon/dist/modules/plugin-base.mjs';`;
const importExtensionUtil = `import ExtensionUtil from 'chrome-extension://lnnmjmalakahagblkkcnjkoaihlfglon/dist/modules/extension-util.mjs';`;
const SPLITTER = '\vLS-SPLIT';

module.exports = function makeCS() {
    return {
        name: 'make-cs', // this name will show up in warnings and errors
        generateBundle(options, bundle) {
            // files can likely be removed from the bundle
            const keys = Object.keys(bundle);
            const matchingFilename = keys.find(x => x.includes('.matching.'));
            const plugin = matchingFilename.split('.')[0];
            const backendFilename = `${plugin}.backend.resolved.js`;

            const backendFile = bundle[backendFilename].code;
            const matchingCSFile = bundle[matchingFilename].code;

            // wrap in IIFE and take out export (not valid for eval)
            const matchingCS = `allPlugins.${plugin} = (() => { ${matchingCSFile.toString().replace('export default', 'return')} })()`;

            bundle[matchingFilename].code = importPluginBase
                    + importExtensionUtil
                    + backendFile
                    + SPLITTER
                    + matchingCS
                    + SPLITTER
                    + matchingCS;
            delete bundle[backendFilename];
            bundle[matchingFilename].fileName = `${plugin}.ls`;
        },
    };
}
