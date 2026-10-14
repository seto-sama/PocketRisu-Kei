import { beforeEach, describe, expect, test, vi } from 'vitest'

const { storage } = vi.hoisted(() => ({
    storage: new Map<string, Uint8Array>(),
}))

vi.mock('src/ts/storage/database.svelte', () => ({
    getCurrentCharacter: () => null,
}))

vi.mock('src/ts/storage/nodeStorage', () => ({
    NodeStorage: class {
        async setItem(key: string, value: Uint8Array) {
            storage.set(key, value)
        }

        async getItem(key: string) {
            return storage.get(key) ?? null
        }

        async getItems(keys: string[]) {
            return keys
                .filter(key => storage.has(key))
                .map(key => ({ key, value: storage.get(key)! }))
        }

        async removeItem(key: string) {
            storage.delete(key)
        }

        async keys(prefix: string) {
            return [...storage.keys()].filter(key => key.startsWith(prefix))
        }
    },
}))

const { getInlayMeta, getInlayMetasBatch, setInlayMeta } = await import('../inlayMeta')

beforeEach(() => {
    storage.clear()
})

describe('inlay image generation metadata', () => {
    test('preserves generation seed and hidden preset metadata in single and batch reads', async () => {
        const meta = {
            createdAt: 1,
            updatedAt: 2,
            imageGeneration: {
                prompt: 'positive',
                negativePrompt: 'negative',
                seed: 4_294_967_295,
                preset: { tagBundleNames: ['Miku', 'Black Suit'], sceneName: 'smile' },
            },
        }
        await setInlayMeta('seeded', meta)
        expect(await getInlayMeta('seeded')).toMatchObject(meta)
        expect(await getInlayMetasBatch(['seeded'])).toMatchObject({ seeded: meta })
    })

    test('drops an invalid legacy seed without dropping the prompts', async () => {
        storage.set('inlay_meta/invalid-seed', new TextEncoder().encode(JSON.stringify({
            createdAt: 1,
            updatedAt: 2,
            imageGeneration: {
                prompt: 'positive',
                negativePrompt: 'negative',
                seed: 'not-a-number',
            },
        })))

        expect(await getInlayMeta('invalid-seed')).toMatchObject({
            imageGeneration: {
                prompt: 'positive',
                negativePrompt: 'negative',
                seed: undefined,
            },
        })
    })
})
