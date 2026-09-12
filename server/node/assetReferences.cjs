'use strict';

const STORED_ASSET_PREFIX = 'assets/';
const PLUGIN_ASSET_STORAGE_PREFIX = 'cache/plugin-storage/';
const ASSET_PATH_PATTERN = /assets(?:\/|\\+)[\w-]+\.\w+/g;

function assetBasename(value) {
    if (!value) return '';
    return String(value).replace(/\\/g, '/').split('/').pop();
}

function extractAssetReferences(value) {
    let text;
    if (typeof value === 'string') text = value;
    else {
        try { text = JSON.stringify(value) ?? ''; } catch { return []; }
    }
    return Array.from(
        text.matchAll(ASSET_PATH_PATTERN),
        (match) => match[0].replace(/\\+/g, '/'),
    );
}

function collectDatabaseAssetBasenames(
    dbObj,
    { assetsOnly = false, includeModuleAssets = true } = {},
) {
    const references = new Set();
    const add = (value) => {
        if (assetsOnly) {
            const normalized = typeof value === 'string' ? value.replace(/\\/g, '/') : '';
            if (!normalized.startsWith(STORED_ASSET_PREFIX)) return;
        }
        const basename = assetBasename(value);
        if (basename) references.add(basename);
    };
    if (!dbObj) return references;

    add(dbObj.customBackground);
    add(dbObj.userIcon);
    add(dbObj.messageSound);
    add(dbObj.translateSound);
    if (Array.isArray(dbObj.customSounds)) {
        for (const sound of dbObj.customSounds) add(sound?.path);
    }
    add(dbObj.NAIImgConfig?.character_image);
    add(dbObj.NAIImgConfig?.image);

    if (Array.isArray(dbObj.characters)) {
        for (const character of dbObj.characters) {
            if (!character) continue;
            add(character.image);
            if (Array.isArray(character.emotionImages)) for (const item of character.emotionImages) add(item?.[1]);
            if (Array.isArray(character.additionalAssets)) for (const item of character.additionalAssets) add(item?.[1]);
            if (character.vits?.files) for (const value of Object.values(character.vits.files)) add(value);
            if (Array.isArray(character.ccAssets)) for (const asset of character.ccAssets) add(asset?.uri);
            add(character.gptSoVitsConfig?.ref_audio_data?.assetId);
        }
    }
    if (Array.isArray(dbObj.modules)) {
        for (const module of dbObj.modules) {
            if (includeModuleAssets && Array.isArray(module?.assets)) {
                for (const asset of module.assets) add(asset?.[1]);
            }
            add(module?.icon);
        }
    }
    if (Array.isArray(dbObj.personas)) {
        for (const persona of dbObj.personas) {
            add(persona?.icon);
            add(persona?.image);
            if (includeModuleAssets && Array.isArray(persona?.embeddedModule?.assets)) {
                for (const asset of persona.embeddedModule.assets) add(asset?.[1]);
            }
            add(persona?.embeddedModule?.icon);
        }
    }
    if (Array.isArray(dbObj.characterOrder)) {
        for (const item of dbObj.characterOrder) {
            if (!item || typeof item !== 'object') continue;
            add(item.img);
            add(item.imgFile);
        }
    }
    if (Array.isArray(dbObj.botPresets)) {
        for (const preset of dbObj.botPresets) add(preset?.image);
    }
    if (dbObj.pluginCustomStorage && typeof dbObj.pluginCustomStorage === 'object') {
        for (const value of Object.values(dbObj.pluginCustomStorage)) {
            for (const reference of extractAssetReferences(value)) add(reference);
        }
    }
    return references;
}

function collectPersistentPluginAssetBasenames({ listKeys, getValue }) {
    const references = new Set();
    for (const key of listKeys(PLUGIN_ASSET_STORAGE_PREFIX)) {
        try {
            const raw = getValue(key);
            if (!raw) continue;
            const value = Buffer.isBuffer(raw) ? raw.toString('utf-8') : String(raw);
            for (const reference of extractAssetReferences(value)) {
                const basename = assetBasename(reference);
                if (basename) references.add(basename);
            }
        } catch { /* malformed plugin entry cannot provide a reliable reference */ }
    }
    return references;
}

function collectProtectedAssetBasenames(dbObj, storage) {
    const references = collectDatabaseAssetBasenames(dbObj);
    for (const basename of collectPersistentPluginAssetBasenames(storage)) references.add(basename);
    return references;
}

function findOrphanAssets(assetRows, protectedBasenames) {
    return assetRows.filter((asset) => !protectedBasenames.has(assetBasename(asset.key)));
}

module.exports = {
    STORED_ASSET_PREFIX,
    PLUGIN_ASSET_STORAGE_PREFIX,
    assetBasename,
    extractAssetReferences,
    collectDatabaseAssetBasenames,
    collectPersistentPluginAssetBasenames,
    collectProtectedAssetBasenames,
    findOrphanAssets,
};
