import { Buffer } from 'buffer'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const storageHarness = vi.hoisted(() => {
    const values = new Map<string, Uint8Array>()
    const control = {
        writeDelayKey: null as string | null,
        writeDelayGate: null as Promise<void> | null,
        writeDelayStarted: null as (() => void) | null,
        writeFailureKey: null as string | null,
        removeDelayKey: null as string | null,
        removeDelayGate: null as Promise<void> | null,
        removeDelayStarted: null as (() => void) | null,
        removeFailureKey: null as string | null,
    }

    const forageStorage = {
        Init: vi.fn(async () => {}),
        getItem: vi.fn(async (key: string) => {
            const value = values.get(key)
            return value ? new Uint8Array(value) : null
        }),
        getItems: vi.fn(async (keys: string[]) => keys.filter(key => values.has(key))
            .map(key => ({ key, value: new Uint8Array(values.get(key)!) }))),
        setItem: vi.fn(async (key: string, value: Uint8Array) => {
            if (control.writeDelayKey === key) {
                control.writeDelayKey = null
                control.writeDelayStarted?.()
                await control.writeDelayGate
            }
            if (control.writeFailureKey === key) {
                control.writeFailureKey = null
                throw new Error('injected storage write failure')
            }
            values.set(key, new Uint8Array(value))
        }),
        removeItem: vi.fn(async (key: string) => {
            if (control.removeDelayKey === key) {
                control.removeDelayKey = null
                control.removeDelayStarted?.()
                await control.removeDelayGate
            }
            if (control.removeFailureKey === key) {
                control.removeFailureKey = null
                throw new Error('injected storage delete failure')
            }
            values.delete(key)
        }),
        keys: vi.fn(async (prefix = '') =>
            [...values.keys()].filter(key => key.startsWith(prefix))),
    }

    return { values, control, forageStorage }
})

vi.mock('src/ts/storage/autoStorage', () => ({ forageStorage: storageHarness.forageStorage }))
vi.mock('src/ts/parser/parser.svelte', () => ({ hasher: vi.fn(async () => new Uint8Array()) }))
vi.mock('src/ts/globalApi.svelte', () => ({ toGetter: (getter: () => unknown) => getter() }))
vi.mock('src/ts/storage/database.svelte', () => ({ getDatabase: () => ({}) }))

const PREFIX = 'cache/plugin-storage/'

function persistentKey(key: string): string {
    return `${PREFIX}${Buffer.from(key, 'utf-8').toString('base64')
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/g, '')}.json`
}

function deferred() {
    let resolve!: () => void
    const promise = new Promise<void>(done => { resolve = done })
    return { promise, resolve }
}

async function createStorage(owner?: string) {
    const { SafeLocalPluginStorage } = await import('./pluginSafeClass')
    return new SafeLocalPluginStorage(owner)
}

beforeEach(() => {
    storageHarness.values.clear()
    Object.assign(storageHarness.control, {
        writeDelayKey: null,
        writeDelayGate: null,
        writeDelayStarted: null,
        writeFailureKey: null,
        removeDelayKey: null,
        removeDelayGate: null,
        removeDelayStarted: null,
        removeFailureKey: null,
    })
    vi.clearAllMocks()
    vi.resetModules()
})

describe('SafeLocalPluginStorage', () => {
    it('reads legacy JSON values through the storage API', async () => {
        const storage = await createStorage()
        storageHarness.values.set(
            persistentKey('old-value'),
            new TextEncoder().encode(JSON.stringify({ legacy: true })),
        )
        expect(await storage.getItem('old-value')).toEqual({ legacy: true })
    })

    it('preserves falsy and undefined values while returning null for missing keys', async () => {
        const storage = await createStorage()
        for (const value of [0, false, '', null, undefined]) {
            await storage.setItem('value', value)
            expect(await storage.getItem('value')).toBe(value)
        }
        expect(await storage.getItem('missing')).toBeNull()
    })

    it('keeps ownership metadata aligned with writes, removals, and clearing', async () => {
        const storage = await createStorage('plugin')
        const { getOwners } = await import('./pluginStorageMeta')
        await storage.setItem('first', { count: 1 })
        await storage.setItem('second', new Blob(['asset']))
        expect(await getOwners('idb')).toEqual({ first: 'plugin', second: 'plugin' })

        const viewer = await createStorage()
        await viewer.setItem('first', { count: 2 })
        expect(await getOwners('idb')).toEqual({ first: 'plugin', second: 'plugin' })

        await storage.removeItem('first')
        expect(await getOwners('idb')).toEqual({ second: 'plugin' })
        await storage.clear()
        expect(await storage.keys()).toEqual([])
        expect(await getOwners('idb')).toEqual({})
    })

    it('round-trips Blob and ArrayBuffer values after a module reload', async () => {
        const storage = await createStorage()
        const buffer = Uint8Array.of(0, 7, 128, 255).buffer
        await storage.setItem('rich-value', {
            blob: new Blob(['plugin payload'], { type: 'application/octet-stream' }),
            buffer,
        })

        vi.resetModules()
        const reloadedStorage = await createStorage()
        const restored = await reloadedStorage.getItem<{
            blob: Blob
            buffer: ArrayBuffer
        }>('rich-value')

        expect(restored?.blob).toBeInstanceOf(Blob)
        expect(await restored?.blob.text()).toBe('plugin payload')
        expect(restored?.blob.type).toBe('application/octet-stream')
        expect(restored?.buffer).toBeInstanceOf(ArrayBuffer)
        expect([...new Uint8Array(restored!.buffer)]).toEqual([0, 7, 128, 255])
    })

    it('returns fresh buffers so a transferred result cannot detach cached data', async () => {
        const storage = await createStorage()
        await storage.setItem('buffer', Uint8Array.of(1, 2, 3, 254).buffer)

        const first = (await storage.getItem<ArrayBuffer>('buffer'))!
        structuredClone(first, { transfer: [first] })
        const second = (await storage.getItem<ArrayBuffer>('buffer'))!
        expect([...new Uint8Array(second)]).toEqual([1, 2, 3, 254])
    })

    it('snapshots values at submission and applies same-key writes in order', async () => {
        const storage = await createStorage()
        const input = Uint8Array.of(4, 5, 6)
        const snapshotWrite = storage.setItem('snapshot', input.buffer)
        input[0] = 99
        await snapshotWrite
        expect([...new Uint8Array((await storage.getItem<ArrayBuffer>('snapshot'))!)]).toEqual([4, 5, 6])

        const key = persistentKey('ordered')
        const firstWriteStarted = deferred()
        const releaseFirstWrite = deferred()
        storageHarness.control.writeDelayKey = key
        storageHarness.control.writeDelayGate = releaseFirstWrite.promise
        storageHarness.control.writeDelayStarted = firstWriteStarted.resolve

        const firstWrite = storage.setItem('ordered', { revision: 1 })
        await firstWriteStarted.promise
        const secondValue = { revision: 2, bytes: Uint8Array.of(8, 9) }
        const secondWrite = storage.setItem('ordered', secondValue)
        secondValue.revision = 99
        releaseFirstWrite.resolve()
        await Promise.all([firstWrite, secondWrite])

        expect(await storage.getItem('ordered')).toEqual({ revision: 2, bytes: Uint8Array.of(8, 9) })
    })

    it('keeps the last persisted value when a set fails', async () => {
        const storage = await createStorage()
        await storage.setItem('stable', { revision: 1 })
        storageHarness.control.writeFailureKey = persistentKey('stable')

        await expect(storage.setItem('stable', { revision: 2 })).rejects.toThrow('injected storage write failure')
        expect(await storage.getItem('stable')).toEqual({ revision: 1 })
        expect(await storageHarness.forageStorage.getItem(persistentKey('stable')))
            .toEqual(storageHarness.values.get(persistentKey('stable')))
    })

    it('waits for every clear deletion before allowing writes after a failed delete', async () => {
        const storage = await createStorage()
        const failedKey = persistentKey('delete-fails')
        const delayedKey = persistentKey('delete-waits')
        storageHarness.values.set(failedKey, new TextEncoder().encode('1'))
        storageHarness.values.set(delayedKey, new TextEncoder().encode('2'))
        storageHarness.control.removeFailureKey = failedKey
        const deleteStarted = deferred()
        const releaseDelete = deferred()
        storageHarness.control.removeDelayKey = delayedKey
        storageHarness.control.removeDelayGate = releaseDelete.promise
        storageHarness.control.removeDelayStarted = deleteStarted.resolve

        let clearFinished = false
        const clearOutcome = storage.clear().then(
            () => { clearFinished = true; return 'fulfilled' },
            () => { clearFinished = true; return 'rejected' },
        )
        await deleteStarted.promise
        const laterWrite = storage.setItem('after-clear', { safe: true })
        await Promise.resolve()

        expect(clearFinished).toBe(false)
        expect(storageHarness.forageStorage.setItem).not.toHaveBeenCalled()

        releaseDelete.resolve()
        expect(await clearOutcome).toBe('rejected')
        await laterWrite

        expect(storageHarness.values.has(failedKey)).toBe(true)
        expect(storageHarness.values.has(delayedKey)).toBe(false)
        expect(await storage.getItem('after-clear')).toEqual({ safe: true })
    })
})
