import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
    recover: vi.fn(async () => 0),
    DBState: { db: { characters: [] } as Record<string, unknown> },
}))

vi.mock('../../../stores.svelte', () => ({
    DBState: mocks.DBState,
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

describe('chat translation recovery', () => {
    beforeEach(() => {
        mocks.recover.mockClear()
        mocks.DBState.db = {
            characters: [],
            autoTranslate: true,
            autoTranslateLastOutputOnly: false,
            autoTranslateCachedOnly: false,
            translatorType: 'llm',
            translateBeforeHTMLFormatting: true,
        }
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

    it('combines last-output and cached-only eligibility with OR', async () => {
        mocks.DBState.db.autoTranslateLastOutputOnly = true
        mocks.DBState.db.autoTranslateCachedOnly = true
        const cache = {
            get: vi.fn(async (key: string) => key === 'older cached output' ? 'cached translation' : null),
            store: vi.fn(async () => {}),
        }
        const recovery = createRevenantChatTranslationRecovery({
            getTarget: () => null,
            getScope: () => null,
            translationCache: cache,
        })
        const parseMarkdown = vi.fn(async (value: string) => value)

        await expect(recovery.shouldDisplayTranslation(recovery.capture(), {
            data: 'latest uncached output',
            translated: false,
            streaming: false,
            lastOutputAutoTranslationEligible: true,
            parseMarkdown,
        })).resolves.toBe(true)
        await expect(recovery.shouldDisplayTranslation(recovery.capture(), {
            data: 'older cached output',
            translated: false,
            streaming: false,
            lastOutputAutoTranslationEligible: false,
            parseMarkdown,
        })).resolves.toBe(true)
        await expect(recovery.shouldDisplayTranslation(recovery.capture(), {
            data: 'older uncached output',
            translated: false,
            streaming: false,
            lastOutputAutoTranslationEligible: false,
            parseMarkdown,
        })).resolves.toBe(false)
    })
})
