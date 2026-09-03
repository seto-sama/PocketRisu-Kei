'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
    collectDatabaseAssetBasenames,
    collectProtectedAssetBasenames,
    findOrphanAssets,
} = require('../server/node/assetReferences.cjs');

test('database reference scan protects non-character asset fields', () => {
    const references = collectDatabaseAssetBasenames({
        characters: [{
            image: 'assets/character.png',
            gptSoVitsConfig: { ref_audio_data: { assetId: 'assets/reference.wav' } },
        }],
        personas: [{ image: 'assets/legacy-persona.png' }],
        NAIImgConfig: { character_image: 'assets/nai.png' },
        wavespeedImage: { reference_image: 'assets/wavespeed.png' },
        pluginCustomStorage: { nested: { path: 'assets/plugin-db.webp' } },
    });

    assert.deepEqual(references, new Set([
        'nai.png',
        'wavespeed.png',
        'character.png',
        'reference.wav',
        'legacy-persona.png',
        'plugin-db.webp',
    ]));
});

test('persistent plugin references participate in the same orphan scan', () => {
    const values = new Map([
        ['cache/plugin-storage/example.json', Buffer.from('{"path":"assets\\\\plugin-kv.mp3"}')],
    ]);
    const storage = {
        listKeys: (prefix) => [...values.keys()].filter((key) => key.startsWith(prefix)),
        getValue: (key) => values.get(key),
    };
    const protectedAssets = collectProtectedAssetBasenames({ characters: [] }, storage);
    const orphans = findOrphanAssets([
        { key: 'assets/plugin-kv.mp3', size: 10 },
        { key: 'assets/orphan.png', size: 20 },
    ], protectedAssets);

    assert.deepEqual(orphans, [{ key: 'assets/orphan.png', size: 20 }]);
});
