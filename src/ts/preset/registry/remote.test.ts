import { beforeEach, describe, expect, it, vi } from 'vitest'

const storeStub = vi.hoisted(() => ({ DBState: { db: {} as any } }))
vi.mock('src/ts/stores.svelte', () => storeStub)
vi.mock('src/ts/globalApi.svelte', () => ({
    fetchNative: () => Promise.reject(new Error('default fetch must not be used in this test')),
}))
vi.mock('src/ts/storage/persistentKv', () => ({
    readPersistentJson: () => Promise.reject(new Error('default cache must not be used in this test')),
    writePersistentJson: () => Promise.reject(new Error('default cache must not be used in this test')),
}))

import {
    getModelsDevCatalog,
    getOfficialRegistry,
    isOfficialRegistryId,
    isRefetchGuarded,
    resetModelsDevRuntimeForTests,
    syncRemoteRegistry,
    type RemoteRegistryDependencies,
} from './remote'
import { getOfficialRegistryId } from './loader'

const NOW = 1_800_000_000_000
let testDb: Record<string, any>
const state = {
    body: '',
    status: 200,
    fetchCount: 0,
    persistent: null as unknown,
}

function dependencies(
    overrides: RemoteRegistryDependencies = {},
): RemoteRegistryDependencies {
    return {
        db: testDb,
        now: () => NOW,
        fetchImpl: async () => {
            state.fetchCount += 1
            return new Response(state.body, { status: state.status })
        },
        readCache: async () => state.persistent as any,
        writeCache: async (_key, value) => { state.persistent = value },
        ...overrides,
    }
}

function catalog() {
    return {
        demo: {
            id: 'demo',
            name: 'Demo',
            npm: '@ai-sdk/openai-compatible',
            api: 'https://api.demo.test/v1',
            env: ['DEMO_API_KEY'],
            doc: 'https://docs.demo.test',
            models: {
                chat: {
                    id: 'chat',
                    name: 'Demo Chat',
                    attachment: false,
                    reasoning: false,
                    tool_call: true,
                    structured_output: true,
                    temperature: true,
                    release_date: '2026-01-01',
                    last_updated: '2026-06-01',
                    modalities: { input: ['text'], output: ['text'] },
                    limit: { context: 128000, output: 8192 },
                    cost: { input: 1, output: 4, cache_read: 0.1 },
                },
            },
        },
    }
}

beforeEach(() => {
    testDb = {}
    state.body = JSON.stringify(catalog())
    state.status = 200
    state.fetchCount = 0
    state.persistent = null
    resetModelsDevRuntimeForTests()
})

describe('syncRemoteRegistry', () => {
    it('downloads models.dev into the separate cache and exposes profiles', async () => {
        const deps = dependencies()
        const result = await syncRemoteRegistry(false, deps)

        expect(result).toMatchObject({ ok: true, changed: true, downloaded: true })
        expect(state.fetchCount).toBe(1)
        expect((state.persistent as any).catalog.demo.models.chat).toBeTruthy()
        expect((await getModelsDevCatalog(deps))?.demo.models.chat.cost)
            .toEqual({ input: 1, output: 4, cache_read: 0.1 })
        expect(testDb.modelProfileRegistryCache).toBeUndefined()

        const entry = getOfficialRegistry().registries[getOfficialRegistryId()]
        expect(entry?.profiles?.['demo:chat']).toBeTruthy()
        expect(entry?.profiles?.['developer:echo']).toBeTruthy()
        expect(entry?.profiles?.['developer:custom']).toBeTruthy()
    })

    it('hydrates a fresh persistent cache without a network request', async () => {
        state.persistent = {
            schemaVersion: 1,
            fetchedAt: NOW,
            contentHash: 'cached',
            catalog: catalog(),
        }

        const result = await syncRemoteRegistry(false, dependencies())

        expect(result).toMatchObject({ ok: true, changed: false, downloaded: false })
        expect(state.fetchCount).toBe(0)
        expect(getOfficialRegistry().registries[getOfficialRegistryId()]
            ?.profiles?.['demo:chat']).toBeTruthy()
    })

    it('keeps Developer profiles visible when models.dev fails', async () => {
        state.status = 503
        const result = await syncRemoteRegistry(false, dependencies())

        expect(result.ok).toBe(false)
        const profiles = getOfficialRegistry().registries[getOfficialRegistryId()]?.profiles
        expect(profiles?.['developer:echo']).toBeTruthy()
        expect(profiles?.['developer:custom']).toBeTruthy()
    })

    it('force refreshes even when the in-memory catalog is fresh', async () => {
        const deps = dependencies()
        await syncRemoteRegistry(false, deps)
        const updated = catalog() as any
        updated.demo.models.next = { ...updated.demo.models.chat, id: 'next', name: 'Next' }
        state.body = JSON.stringify(updated)

        await syncRemoteRegistry(true, deps)

        expect(getOfficialRegistry().registries[getOfficialRegistryId()]?.profiles)
            .toHaveProperty('demo:next')
    })

    it('migrates the legacy hidden filter and leaves later providers off', async () => {
        testDb = {
            modelProfileHiddenProviderIds: [],
            modelProfileProviderFilterInitialized: true,
        }
        await syncRemoteRegistry(false, dependencies())

        expect(testDb.modelProfileVisibleProviderIds).toEqual(['demo'])
        expect(testDb.modelProfileHiddenProviderIds).toBeUndefined()

        const updated = catalog() as any
        updated.newcomer = {
            ...updated.demo,
            id: 'newcomer',
            name: 'Newcomer',
        }
        state.body = JSON.stringify(updated)
        await syncRemoteRegistry(true, dependencies())

        expect(testDb.modelProfileVisibleProviderIds).toEqual(['demo'])
    })
})

describe('registry identifiers and refresh gate', () => {
    it('recognizes the new id and legacy bundled snapshots', () => {
        expect(isOfficialRegistryId(getOfficialRegistryId())).toBe(true)
        expect(isOfficialRegistryId('bundled')).toBe(true)
        expect(isOfficialRegistryId('custom')).toBe(false)
    })

    it('uses a six-hour freshness interval', () => {
        expect(isRefetchGuarded(undefined)).toBe(false)
        expect(isRefetchGuarded(NOW - 60_000, NOW)).toBe(true)
        expect(isRefetchGuarded(NOW - 7 * 60 * 60 * 1000, NOW)).toBe(false)
    })
})
