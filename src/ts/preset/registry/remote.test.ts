import { beforeEach, describe, expect, it, vi } from 'vitest'

const { mockDb, state } = vi.hoisted(() => ({
    mockDb: { db: {} as any },
    state: {
        body: '',
        status: 200,
        fetchCount: 0,
        persistent: null as unknown,
    },
}))

vi.mock('src/ts/globalApi.svelte', () => ({
    fetchNative: vi.fn(async () => {
        state.fetchCount++
        return new Response(state.body, { status: state.status })
    }),
}))

vi.mock('src/ts/storage/persistentKv', () => ({
    readPersistentJson: vi.fn(async () => state.persistent),
    writePersistentJson: vi.fn(async (_key: string, value: unknown) => {
        state.persistent = value
    }),
}))

vi.mock('src/ts/stores.svelte', () => ({ DBState: mockDb }))

import {
    getModelsDevCatalog,
    getOfficialRegistry,
    isOfficialRegistryId,
    isRefetchGuarded,
    resetModelsDevRuntimeForTests,
    syncRemoteRegistry,
} from './remote'
import { getOfficialRegistryId } from './loader'

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
    mockDb.db = {}
    state.body = JSON.stringify(catalog())
    state.status = 200
    state.fetchCount = 0
    state.persistent = null
    resetModelsDevRuntimeForTests()
})

describe('syncRemoteRegistry', () => {
    it('downloads models.dev into the separate cache and exposes profiles', async () => {
        const result = await syncRemoteRegistry()

        expect(result).toMatchObject({ ok: true, changed: true, downloaded: true })
        expect(state.fetchCount).toBe(1)
        expect((state.persistent as any).catalog.demo.models.chat).toBeTruthy()
        expect((await getModelsDevCatalog())?.demo.models.chat.cost)
            .toEqual({ input: 1, output: 4, cache_read: 0.1 })
        expect(mockDb.db.modelProfileRegistryCache).toBeUndefined()

        const entry = getOfficialRegistry().registries[getOfficialRegistryId()]
        expect(entry?.profiles?.['demo:chat']).toBeTruthy()
        expect(entry?.profiles?.['developer:echo']).toBeTruthy()
        expect(entry?.profiles?.['developer:custom']).toBeTruthy()
    })

    it('hydrates a fresh persistent cache without a network request', async () => {
        state.persistent = {
            schemaVersion: 1,
            fetchedAt: Date.now(),
            contentHash: 'cached',
            catalog: catalog(),
        }

        const result = await syncRemoteRegistry()

        expect(result).toMatchObject({ ok: true, changed: false, downloaded: false })
        expect(state.fetchCount).toBe(0)
        expect(getOfficialRegistry().registries[getOfficialRegistryId()]
            ?.profiles?.['demo:chat']).toBeTruthy()
    })

    it('keeps Developer profiles visible when models.dev fails', async () => {
        state.status = 503
        const result = await syncRemoteRegistry()

        expect(result.ok).toBe(false)
        const profiles = getOfficialRegistry().registries[getOfficialRegistryId()]?.profiles
        expect(Object.keys(profiles ?? {})).toEqual([
            'developer:echo',
            'developer:custom',
        ])
    })

    it('force refreshes even when the in-memory catalog is fresh', async () => {
        await syncRemoteRegistry()
        await syncRemoteRegistry(true)
        expect(state.fetchCount).toBe(2)
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
        expect(isRefetchGuarded(Date.now() - 60_000)).toBe(true)
        expect(isRefetchGuarded(Date.now() - 7 * 60 * 60 * 1000)).toBe(false)
    })
})
