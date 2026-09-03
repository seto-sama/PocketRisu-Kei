import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
    recover: vi.fn(async () => 0),
}))

vi.mock('../../../stores.svelte', () => ({
    DBState: { db: { characters: [] } },
    selIdState: { selId: 0 },
}))

vi.mock('../auxiliary', () => ({
    acknowledgeRecoverableTranslation: vi.fn(),
    getRecoverableTranslationCacheKeyForTarget: vi.fn(() => null),
    isRecoverableTranslationSnapshotLoaded: vi.fn(() => true),
    subscribeRecoverableTranslations: vi.fn(() => () => {}),
}))

vi.mock('./translationRecovery', () => ({
    recoverRevenantTranslationJobs: mocks.recover,
}))

import { createRevenantChatTranslationRecovery } from './chatTranslationRecovery.svelte'

describe('chat translation recovery result', () => {
    beforeEach(() => {
        mocks.recover.mockClear()
    })

    it('reports that a terminal recovery produced no cache entry', async () => {
        const cache = {
            get: vi.fn(async () => null),
            store: vi.fn(async () => {}),
        }
        const recovery = createRevenantChatTranslationRecovery({
            getTarget: () => null,
            getScope: () => null,
            translationCache: cache,
        })

        await expect(recovery.waitForResult({
            pending: true,
            cacheKey: 'source',
            scope: { characterId: 'character-1', roomId: 'room-1' },
            target: null,
        })).resolves.toBe(false)

        expect(mocks.recover).toHaveBeenCalledOnce()
        expect(cache.get).toHaveBeenCalledWith('source')
    })
})
