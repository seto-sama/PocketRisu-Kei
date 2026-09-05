'use strict';

const {
    assetBasename,
    collectDatabaseAssetBasenames,
} = require('./assetReferences.cjs');

function stripToSettingsOnly(database) {
    return {
        ...database,
        characters: [],
        characterOrder: [],
    };
}

/** Build the database and exact asset allow-list used by estimate and export. */
async function buildSettingsBackupPlan({
    databaseValue,
    assetRows,
    decodeDatabase,
    encodeDatabase,
    includeModuleAssets = true,
}) {
    if (!databaseValue) return null;

    const trimmed = stripToSettingsOnly(await decodeDatabase(databaseValue));
    const encodedDatabase = Buffer.from(encodeDatabase(trimmed));
    const withModuleAssets = collectDatabaseAssetBasenames(trimmed);
    const withoutModuleAssets = collectDatabaseAssetBasenames(trimmed, {
        includeModuleAssets: false,
    });
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
        encodedDatabase,
        includedAssetNames,
        includedAssets,
        breakdown: {
            dbBytes: encodedDatabase.length,
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
    stripToSettingsOnly,
    buildSettingsBackupPlan,
};
