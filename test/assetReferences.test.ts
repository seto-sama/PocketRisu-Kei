import { describe, expect, it } from 'vitest'
import { encodeLocalPluginStorageValue } from '../shared/localPluginStorageValue.mjs'
import { Packr } from 'msgpackr'
import assetReferences from '../server/assetReferences.cjs'

const {
    collectDatabaseAssetBasenames,
    collectProtectedAssetBasenames,
    findOrphanAssets,
} = assetReferences

const pluginStoragePackr = new Packr({ useRecords: false })

function assetRows(...names: string[]) {
    return names.map((name) => ({ key: `assets/${name}` }))
}

describe('asset references', () => {
    it('database reference scan protects non-character asset fields', () => {
        const references = collectDatabaseAssetBasenames({
            characters: [{
                image: 'assets/character.png',
                gptSoVitsConfig: { ref_audio_data: { assetId: 'assets/reference.wav' } },
            }],
            personas: [{ image: 'assets/legacy-persona.png' }],
            NAIImgConfig: { character_image: 'assets/nai.png' },
            pluginCustomStorage: { nested: { path: 'assets/plugin-db.webp' } },
        })

        expect(references).toEqual(new Set([
            'nai.png',
            'character.png',
            'reference.wav',
            'legacy-persona.png',
            'plugin-db.webp',
        ]))
    })

    it('localStorage strings and localForage rich values participate in the same orphan scan', async () => {
        const entries = [
            {
                namespace: 'localStorage',
                key: 'plugin-string',
                value: pluginStoragePackr.pack('{"path":"assets\\\\plugin-kv.mp3","assets/key.png":true}'),
            },
            {
                namespace: 'localForage',
                key: 'plugin-rich-value',
                value: await encodeLocalPluginStorageValue({ nested: 'assets/localforage.webp' }),
            },
        ]
        const protectedAssets = collectProtectedAssetBasenames({ characters: [] }, entries)
        const orphans = findOrphanAssets([
            { key: 'assets/plugin-kv.mp3', size: 10 },
            { key: 'assets/key.png', size: 15 },
            { key: 'assets/localforage.webp', size: 7 },
            { key: 'assets/orphan.png', size: 20 },
        ], protectedAssets)

        expect(orphans).toEqual([{ key: 'assets/orphan.png', size: 20 }])
    })

    it('protects strings in cyclic MessagePack object, Map, and Set values', async () => {
        const value: any = {
            path: 'assets/object.png',
            paths: ['assets/array.png'],
            map: new Map([['assets/map-key.webp', { path: 'assets/map-value.jpg' }]]),
            set: new Set(['assets/set.gif']),
            bytes: new TextEncoder().encode('assets/binary.png'),
        }
        value.map.get('assets/map-key.webp').cycle = value
        value.set.add(value)
        const protectedAssets = collectProtectedAssetBasenames({}, [{
            namespace: 'localForage',
            key: 'plugin-rich-value',
            value: await encodeLocalPluginStorageValue(value),
        }])

        expect([...protectedAssets].sort()).toEqual([
            'array.png', 'map-key.webp', 'map-value.jpg', 'object.png', 'set.gif',
        ])
        expect(findOrphanAssets(assetRows(
            'object.png', 'array.png', 'map-key.webp', 'map-value.jpg', 'set.gif', 'binary.png', 'orphan.png',
        ), protectedAssets).map((asset: any) => asset.key)).toEqual([
            'assets/binary.png', 'assets/orphan.png',
        ])
    })

    it('does not treat binary byte arrays or Blob contents as asset references', async () => {
        const value = {
            bytes: new TextEncoder().encode('assets/typed-array.png'),
            blob: new Blob(['assets/blob.png'], { type: 'text/plain' }),
        }
        const protectedAssets = collectProtectedAssetBasenames({}, [{
            namespace: 'localForage',
            key: 'plugin-rich-value',
            value: await encodeLocalPluginStorageValue(value),
        }])

        expect([...protectedAssets]).toEqual([])
        expect(findOrphanAssets(assetRows('typed-array.png', 'blob.png'), protectedAssets)
            .map((asset: any) => asset.key)).toEqual([
            'assets/typed-array.png', 'assets/blob.png',
        ])
    })
})
