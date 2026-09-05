'use strict';

function installedV3Plugins(plugins) {
    return new Map((plugins ?? [])
        .filter(plugin => plugin?.version === '3.0' && typeof plugin.name === 'string')
        .map(plugin => [plugin.name, plugin]));
}

function classifiedPluginOwner(ownerMeta, key, knownV3Names) {
    const owner = ownerMeta?.[key]?.plugin;
    return typeof owner === 'string' && knownV3Names.has(owner) ? owner : null;
}

module.exports = {
    classifiedPluginOwner,
    installedV3Plugins,
};
