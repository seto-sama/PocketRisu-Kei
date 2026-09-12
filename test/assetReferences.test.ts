import { describe, expect, it } from 'vitest'
import assetReferences from '../server/node/assetReferences.cjs'

const {
    collectDatabaseAssetBasenames,
    collectProtectedAssetBasenames,
    findOrphanAssets,
} = assetReferences

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

    it('persistent plugin references participate in the same orphan scan', () => {
        const values = new Map([
            ['cache/plugin-storage/example.json', Buffer.from('{"path":"assets\\\\plugin-kv.mp3"}')],
        ])
        const storage = {
            listKeys: (prefix: string) => [...values.keys()].filter((key) => key.startsWith(prefix)),
            getValue: (key: string) => values.get(key),
        }
        const protectedAssets = collectProtectedAssetBasenames({ characters: [] }, storage)
        const orphans = findOrphanAssets([
            { key: 'assets/plugin-kv.mp3', size: 10 },
            { key: 'assets/orphan.png', size: 20 },
        ], protectedAssets)

        expect(orphans).toEqual([{ key: 'assets/orphan.png', size: 20 }])
    })
})
