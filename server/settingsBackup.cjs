'use strict';

const {
    assetBasename,
    collectDatabaseAssetBasenames,
    collectPersistentPluginAssetBasenames,
} = require('./assetReferences.cjs');

function stripToSettingsOnly(database) {
    return {
        ...database,
        characters: [],
        characterOrder: [],
    };
}

function buildSettingsBackupPlan({
    database,
    assetRows,
    includeModuleAssets = true,
    pluginStorage = [],
}) {
    const trimmed = stripToSettingsOnly(database);
    const withModuleAssets = collectDatabaseAssetBasenames(trimmed);
    const withoutModuleAssets = collectDatabaseAssetBasenames(trimmed, {
        includeModuleAssets: false,
    });
    for (const basename of collectPersistentPluginAssetBasenames(pluginStorage)) {
        withModuleAssets.add(basename);
        withoutModuleAssets.add(basename);
    }
    const includedAssetNames = includeModuleAssets
        ? withModuleAssets
        : withoutModuleAssets;
    const includedAssets = assetRows.filter(
        (asset) => includedAssetNames.has(assetBasename(asset.key)),
    );

    let baseCount = 0;
    let baseBytes = 0;
    let moduleCount = 0;
    let moduleBytes = 0;
    for (const asset of assetRows) {
        const basename = assetBasename(asset.key);
        if (withoutModuleAssets.has(basename)) {
            baseCount++;
            baseBytes += asset.size;
        }
        else if (withModuleAssets.has(basename)) {
            moduleCount++;
            moduleBytes += asset.size;
        }
    }

    return {
        database: trimmed,
        includedAssets,
        breakdown: {
            baseAssets: { count: baseCount, bytes: baseBytes },
            moduleAssets: {
                count: moduleCount,
                bytes: moduleBytes,
                moduleCount: (trimmed.modules ?? []).filter(
                    (module) => Array.isArray(module?.assets) && module.assets.length > 0,
                ).length,
            },
        },
    };
}

module.exports = {
    buildSettingsBackupPlan,
};
