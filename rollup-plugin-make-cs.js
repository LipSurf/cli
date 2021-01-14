const ParsedPlugin = require('./lib/ParsedPlugin').default;
const jscodeshift = require('jscodeshift');

// using "__MSG_@@extension_id__" doesn't work here
// can be overriden with EXT_ID
const EXT_ID = process.env.EXT_ID || 'lnnmjmalakahagblkkcnjkoaihlfglon';
const importPluginBase = `import PluginBase from 'chrome-extension://${EXT_ID}/dist/modules/plugin-base.js';`;
const importExtensionUtil = `import ExtensionUtil from 'chrome-extension://${EXT_ID}/dist/modules/extension-util.js';`;
const SPLITTER = '\vLS-SPLIT';

const PART_NAMES = ['backend', 'matching.cs', 'nonmatching.cs'];

function versionConvertDots(v) {
	return v.replace(/\./g, '-')
}

module.exports = function makeCS(baseImports = true) {
    return {
        name: 'make-cs', // this name will show up in warnings and errors
        generateBundle(options, bundle, isWrite) {
            if (isWrite) {
                // files can likely be removed from the bundle
                const keys = Object.keys(bundle);
                const whitelistedKeys = [];
                let version;

                for (let plan of [0, 10, 20]) {
                    const matchingFilename = keys.find(x => x.includes(`${plan}.matching.`));
                    if (!matchingFilename) 
                        throw new Error(`Could not find matching file name in ${keys}`);
                    const splitted = matchingFilename.split('.')
                    const pluginId = splitted[0];

                    const [backend, matchingCS, nonMatchingCS] = PART_NAMES.map(partName => {
                        if (partName !== 'backend')
                            partName = `${plan}.${partName}`;
                        let fullPart = bundle[`${pluginId}.${partName}.resolved.js`].code;
                        // also make sure it's not blank
                        if (partName.includes('.cs') && fullPart.trim())
                            // wrap in IIFE and take out export (not valid for eval)
                            fullPart = `allPlugins.${pluginId} = (() => { ${fullPart.replace('export default', 'return')} })()`
                        return fullPart.trim();
                    });

                    // hacky
                    if (!version) {
                        const parsedPlugin = new ParsedPlugin(jscodeshift, backend);
                        version = versionConvertDots(parsedPlugin.getVersion());
                    }

                    if (plan === 0 || !(matchingCS === '' && nonMatchingCS === '')) {
                        const newFileName = `${pluginId}.${version}.${plan}.ls`;
                        // console.log('whitelisting', newFileName, matchingCS.substr(0, 10).length, nonMatchingCS.substr(0, 10).length)
                        whitelistedKeys.push(newFileName);
                        let baseImportsStr = '';
                        if (baseImports) {
                            baseImportsStr = importPluginBase + importExtensionUtil;
                        }
                        bundle[matchingFilename].code = baseImportsStr
                                + backend
                                + SPLITTER
                                + matchingCS
                                + SPLITTER
                                + nonMatchingCS;
                        bundle[matchingFilename].fileName = newFileName;
                        bundle[newFileName] = bundle[matchingFilename]
                    }
                }
                Object.keys(bundle)
                    .filter(key => !whitelistedKeys.includes(key))
                    .forEach(key => {
                        delete bundle[key];
                    });
            }
        },
    };
}
