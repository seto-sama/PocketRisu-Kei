'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
    buildSettingsBackupPlan,
    stripToSettingsOnly,
} = require('../server/node/settingsBackup.cjs');

const database = {
    characters: [{ image: 'assets/character.png', chats: [{ message: ['secret'] }] }],
    characterOrder: ['character-id'],
    apiType: 'openai',
    personas: [{ icon: 'assets/shared.png' }],
    modules: [{
        icon: 'assets/module-icon.png',
        assets: [
            ['only', 'assets/module-only.png'],
            ['shared', 'assets/shared.png'],
        ],
    }],
};

const assetRows = [
    { key: 'assets/character.png', size: 10 },
    { key: 'assets/shared.png', size: 20 },
    { key: 'assets/module-icon.png', size: 30 },
    { key: 'assets/module-only.png', size: 40 },
    { key: 'assets/orphan.png', size: 50 },
];

function createPlan(includeModuleAssets) {
    return buildSettingsBackupPlan({
        databaseValue: Buffer.from('database'),
        assetRows,
        decodeDatabase: async () => database,
        encodeDatabase: (value) => Buffer.from(JSON.stringify(value)),
        includeModuleAssets,
    });
}

test('settings backup removes characters and their ordering', () => {
    const trimmed = stripToSettingsOnly(database);
    assert.deepEqual(trimmed.characters, []);
    assert.deepEqual(trimmed.characterOrder, []);
    assert.equal(trimmed.apiType, 'openai');
    assert.equal(database.characters.length, 1);
});

test('module asset option never drops assets with another settings owner', async () => {
    const withModules = await createPlan(true);
    const withoutModules = await createPlan(false);

    assert(withModules.includedAssetNames.has('module-only.png'));
    assert(!withoutModules.includedAssetNames.has('module-only.png'));
    assert(withoutModules.includedAssetNames.has('shared.png'));
    assert(withoutModules.includedAssetNames.has('module-icon.png'));
    assert(!withoutModules.includedAssetNames.has('character.png'));
    assert.deepEqual(
        withoutModules.includedAssets.map((asset) => asset.key),
        ['assets/shared.png', 'assets/module-icon.png'],
    );
    assert.equal(withModules.breakdown.moduleAssets.bytes, 40);
    assert.equal(withModules.breakdown.moduleAssets.count, 1);

    const exportedDatabase = JSON.parse(withoutModules.encodedDatabase.toString('utf-8'));
    assert.deepEqual(exportedDatabase.characters, []);
    assert.deepEqual(exportedDatabase.characterOrder, []);
});
