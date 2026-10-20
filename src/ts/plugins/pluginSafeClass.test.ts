import { decode, encode } from 'msgpackr/index-no-eval'
import { beforeEach, describe, expect, it, vi } from 'vitest'

type RecordValue = { value: Uint8Array, owner?: string }

const storageHarness = vi.hoisted(() => {
    const values = new Map<string, Map<string, RecordValue>>()
    const control = {
        writeFailureKey: null as string | null,
        writeDelayKey: null as string | null,
        writeDelayGate: null as Promise<void> | null,
        writeDelayStarted: null as (() => void) | null,
        importFailure: false,
    }
    const getNamespace = (namespace: string) => {
        let entries = values.get(namespace)
        if (!entries) values.set(namespace, entries = new Map())
        return entries
    }
    const forageStorage = {
        pluginStorageRequest: vi.fn(async (namespace: string, request: any): Promise<any> => {
            const entries = getNamespace(namespace)
            if (request.op === 'get') {
                const record = entries.get(request.key)
                return { value: record ? new Uint8Array(record.value) : null }
            }
            if (request.op === 'set') {
                if (control.writeDelayKey === request.key) {
                    control.writeDelayKey = null
                    control.writeDelayStarted?.()
                    await control.writeDelayGate
                }
                if (control.writeFailureKey === request.key) {
                    control.writeFailureKey = null
                    throw new Error('injected storage write failure')
                }
                const existing = entries.get(request.key)
                entries.set(request.key, {
                    value: new Uint8Array(request.value),
                    owner: request.owner ?? existing?.owner,
                })
                return { success: true }
            }
            if (request.op === 'remove') {
                entries.delete(request.key)
                return { success: true }
            }
            if (request.op === 'clear') {
                entries.clear()
                return { success: true }
            }
            if (request.op === 'list') {
                return { entries: [...entries].map(([key, record]) => ({ key, owner: record.owner })) }
            }
            if (request.op === 'import') {
                if (control.importFailure) throw new Error('injected import failure')
                for (const entry of request.entries) {
                    if (!entries.has(entry.key)) entries.set(entry.key, {
                        value: new Uint8Array(entry.value), owner: entry.owner,
                    })
                }
                return { success: true }
            }
            throw new Error(`unknown operation ${request.op}`)
        }),
    }
    return { values, control, forageStorage }
})

vi.mock('src/ts/storage/autoStorage', () => ({ forageStorage: storageHarness.forageStorage }))
vi.mock('src/ts/storage/database.svelte', () => ({ getDatabase: () => ({}) }))

function deferred() {
    let resolve!: () => void
    const promise = new Promise<void>(done => { resolve = done })
    return { promise, resolve }
}

async function createStorages(owner?: string) {
    const { SafeLocalPluginStorage, SafeLocalStorage } = await import('./pluginSafeClass')
    return {
        local: new SafeLocalStorage(owner),
        forage: new SafeLocalPluginStorage(owner),
    }
}

beforeEach(() => {
    storageHarness.values.clear()
    Object.assign(storageHarness.control, {
        writeFailureKey: null,
        writeDelayKey: null,
        writeDelayGate: null,
        writeDelayStarted: null,
        importFailure: false,
    })
    localStorage.clear()
    vi.clearAllMocks()
    vi.resetModules()
})

describe('server-backed plugin storage', () => {
    it('isolates namespaces and round-trips rich localForage values', async () => {
        const { local, forage } = await createStorages()
        await local.setItem('shared-key', 'local string')
        await forage.setItem('shared-key', {
            blob: new Blob(['plugin payload'], { type: 'application/octet-stream' }),
            buffer: Uint8Array.of(0, 7, 128, 255).buffer,
        })

        expect(await local.getItem('shared-key')).toBe('local string')
        const restored = await forage.getItem<{ blob: Blob, buffer: ArrayBuffer }>('shared-key')
        expect(restored?.blob).toBeInstanceOf(Blob)
        expect(await restored?.blob.text()).toBe('plugin payload')
        expect(restored?.blob.type).toBe('application/octet-stream')
        expect([...new Uint8Array(restored!.buffer)]).toEqual([0, 7, 128, 255])
        expect(await local.keys()).toEqual(['shared-key'])
        expect(await forage.keys()).toEqual(['shared-key'])
    })

    it('stores ownership with the remote value and clears it with that value', async () => {
        const { forage } = await createStorages('plugin')
        const { getOwners } = await import('./pluginStorageMeta')
        const { local } = await createStorages('plugin')
        await local.setItem('local-key', 'value')
        expect(await getOwners('localStorage')).toEqual({ 'local-key': 'plugin' })

        await forage.setItem('first', { count: 1 })
        await forage.setItem('second', new Blob(['asset']))
        expect(await getOwners('localForage')).toEqual({ first: 'plugin', second: 'plugin' })

        const viewer = await createStorages()
        await viewer.forage.setItem('first', { count: 2 })
        expect(await getOwners('localForage')).toEqual({ first: 'plugin', second: 'plugin' })

        await forage.removeItem('first')
        expect(await getOwners('localForage')).toEqual({ second: 'plugin' })
        await forage.clear()
        expect(await forage.keys()).toEqual([])
        expect(await getOwners('localForage')).toEqual({})
    })

    it('snapshots submitted values and applies same-key writes in order', async () => {
        const { forage } = await createStorages()
        const input = Uint8Array.of(4, 5, 6)
        const snapshotWrite = forage.setItem('snapshot', input.buffer)
        input[0] = 99
        await snapshotWrite
        expect([...new Uint8Array((await forage.getItem<ArrayBuffer>('snapshot'))!)]).toEqual([4, 5, 6])

        const firstWriteStarted = deferred()
        const releaseFirstWrite = deferred()
        storageHarness.control.writeDelayKey = 'ordered'
        storageHarness.control.writeDelayGate = releaseFirstWrite.promise
        storageHarness.control.writeDelayStarted = firstWriteStarted.resolve

        const firstWrite = forage.setItem('ordered', { revision: 1 })
        await firstWriteStarted.promise
        const secondValue = { revision: 2, bytes: Uint8Array.of(8, 9) }
        const secondWrite = forage.setItem('ordered', secondValue)
        secondValue.revision = 99
        releaseFirstWrite.resolve()
        await Promise.all([firstWrite, secondWrite])

        expect(await forage.getItem('ordered')).toEqual({ revision: 2, bytes: Uint8Array.of(8, 9) })
    })

    it('keeps the persisted value when a remote set fails', async () => {
        const { forage } = await createStorages()
        await forage.setItem('stable', { revision: 1 })
        storageHarness.control.writeFailureKey = 'stable'

        await expect(forage.setItem('stable', { revision: 2 })).rejects.toThrow('injected storage write failure')
        expect(await forage.getItem('stable')).toEqual({ revision: 1 })
    })

    it('orders clear and later writes after an unfinished write', async () => {
        const { forage, local } = await createStorages()
        const writeStarted = deferred()
        const releaseWrite = deferred()
        storageHarness.control.writeDelayKey = 'before'
        storageHarness.control.writeDelayGate = releaseWrite.promise
        storageHarness.control.writeDelayStarted = writeStarted.resolve

        const before = forage.setItem('before', 'old')
        await writeStarted.promise
        const clear = forage.clear()
        const after = forage.setItem('after', 'new')
        const keys = forage.keys()
        await local.setItem('separate', 'untouched')
        releaseWrite.resolve()

        await Promise.all([before, clear, after])
        expect(await keys).toEqual(['after'])
        expect(await forage.getItem('after')).toBe('new')
        expect(await local.getItem('separate')).toBe('untouched')
    })

    it('migrates legacy localStorage values and owners insert-if-absent', async () => {
        const server = storageHarness.values.get('localStorage') ?? new Map()
        storageHarness.values.set('localStorage', server)
        server.set('existing', { value: encode('server value'), owner: 'server-plugin' })
        localStorage.setItem('safe_plugin_existing', 'old local value')
        localStorage.setItem('safe_plugin_legacy', 'legacy value')
        localStorage.setItem('risu_plugin_storage_owners', JSON.stringify({
            legacy: { plugin: 'old-plugin', updatedAt: 1 },
        }))

        const { local } = await createStorages()
        expect(await local.getItem('existing')).toBe('server value')
        expect(await local.getItem('legacy')).toBe('legacy value')
        expect(localStorage.getItem('safe_plugin_existing')).toBeNull()
        expect(localStorage.getItem('safe_plugin_legacy')).toBeNull()
        expect(localStorage.getItem('risu_plugin_storage_owners')).toBeNull()
        const { getOwners } = await import('./pluginStorageMeta')
        expect(await getOwners('localStorage')).toEqual({ existing: 'server-plugin', legacy: 'old-plugin' })
        expect(decode(server.get('legacy')!.value)).toBe('legacy value')
    })

    it('keeps legacy browser data when import fails and retries safely', async () => {
        localStorage.setItem('safe_plugin_retry', 'still here')
        storageHarness.control.importFailure = true
        const { local } = await createStorages()
        await expect(local.getItem('retry')).rejects.toThrow('injected import failure')
        expect(localStorage.getItem('safe_plugin_retry')).toBe('still here')

        storageHarness.control.importFailure = false
        expect(await local.getItem('retry')).toBe('still here')
        expect(localStorage.getItem('safe_plugin_retry')).toBeNull()
    })
})
