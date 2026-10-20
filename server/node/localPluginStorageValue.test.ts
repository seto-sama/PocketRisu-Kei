// @vitest-environment node
import { describe, expect, it } from 'vitest'
import {
    encodeLocalPluginStorageValue,
    decodeLocalPluginStorageValue,
} from '../../shared/localPluginStorageValue.mjs'

describe('local plugin storage value codec', () => {
    it('writes binary values and continues reading legacy JSON', async () => {
        const value = { prompt: 'hello', values: [1, true, null] }
        const bytes = await encodeLocalPluginStorageValue(value)

        expect(bytes).toBeInstanceOf(Uint8Array)
        expect(() => JSON.parse(new TextDecoder().decode(bytes))).toThrow()
        expect(decodeLocalPluginStorageValue(bytes)).toEqual(value)
        expect(decodeLocalPluginStorageValue(new TextEncoder().encode(JSON.stringify(value)))).toEqual(value)
    })

    it('round trips built-in values, large BigInts, buffer views, cycles, and shared references', async () => {
        const backing = new ArrayBuffer(12)
        const bytes = new Uint8Array(backing)
        bytes.set([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12])
        const view = new Uint16Array(backing, 2, 3)
        const dataView = new DataView(backing, 4, 4)
        const byteView = new Uint8Array(backing, 6, 2)
        const shared = { label: 'same' }
        const value: any = {
            date: new Date('2024-03-04T05:06:07.008Z'),
            map: new Map([[shared, new Set([shared, /a+b/gi])]]),
            regexp: /local\s+plugin/imy,
            bigint: (1n << 180n) + 42n,
            backing,
            view,
            viewAlias: view,
            dataView,
            byteView,
            sharedOne: shared,
            sharedTwo: shared,
        }
        value.self = value

        const decoded = decodeLocalPluginStorageValue(await encodeLocalPluginStorageValue(value))

        expect(decoded.date).toEqual(value.date)
        expect(decoded.bigint).toBe(value.bigint)
        expect(decoded.regexp).toEqual(value.regexp)
        expect(decoded.map).toBeInstanceOf(Map)
        expect(decoded.map.keys().next().value).toEqual({ label: 'same' })
        const decodedSet = decoded.map.values().next().value
        expect(decodedSet).toBeInstanceOf(Set)
        expect([...decodedSet][1]).toEqual(/a+b/gi)
        expect(decoded.self).toBe(decoded)
        expect(decoded.sharedOne).toBe(decoded.sharedTwo)
        expect(decoded.backing).toBeInstanceOf(ArrayBuffer)
        expect(decoded.view).toBeInstanceOf(Uint16Array)
        expect(decoded.dataView).toBeInstanceOf(DataView)
        expect(decoded.byteView).toBeInstanceOf(Uint8Array)
        expect(decoded.view).toBe(decoded.viewAlias)
        expect(decoded.view.buffer).toBe(decoded.backing)
        expect(decoded.dataView.buffer).toBe(decoded.backing)
        expect(decoded.byteView.buffer).toBe(decoded.backing)
        expect(decoded.view.byteOffset).toBe(2)
        expect(decoded.dataView.byteOffset).toBe(4)
        expect(decoded.byteView.byteOffset).toBe(6)
        expect(Array.from(new Uint8Array(decoded.backing))).toEqual(Array.from(bytes))
        expect(Array.from(new Uint8Array(decoded.view.buffer, decoded.view.byteOffset, decoded.view.byteLength)))
            .toEqual([3, 4, 5, 6, 7, 8])
        const decodedMapKey = decoded.map.keys().next().value
        expect([...decodedSet][0]).toBe(decodedMapKey)
    })

    it('round trips Blob and File bytes and metadata inside cyclic graphs', async () => {
        const blob = new Blob(['blob-data'], { type: 'text/plain' })
        const file = new File(['file-data'], 'prompt.json', {
            type: 'application/json',
            lastModified: 1_700_000_000_123,
        })
        const value: any = { blob, blobAlias: blob, file }
        value.self = value

        const decoded = decodeLocalPluginStorageValue(await encodeLocalPluginStorageValue(value))

        expect(decoded.self).toBe(decoded)
        expect(decoded.blob).toBeInstanceOf(Blob)
        expect(decoded.blobAlias).toBe(decoded.blob)
        expect(decoded.blob).not.toBeInstanceOf(File)
        expect(decoded.blob.type).toBe('text/plain')
        expect(await decoded.blob.text()).toBe('blob-data')
        expect(decoded.file).toBeInstanceOf(File)
        expect(decoded.file.name).toBe('prompt.json')
        expect(decoded.file.type).toBe('application/json')
        expect(decoded.file.lastModified).toBe(1_700_000_000_123)
        expect(await decoded.file.text()).toBe('file-data')
    })

    it('captures the object graph when encoding is called and rejects unsupported values', async () => {
        const value = { text: 'before', nested: { count: 1 }, blob: new Blob(['fixed']) }
        const pending = encodeLocalPluginStorageValue(value)
        value.text = 'after'
        value.nested.count = 2

        const decoded = decodeLocalPluginStorageValue(await pending)
        expect(decoded.text).toBe('before')
        expect(decoded.nested.count).toBe(1)
        expect(await decoded.blob.text()).toBe('fixed')
        await expect(encodeLocalPluginStorageValue({ bad: () => undefined })).rejects.toThrow(/Functions/)
        await expect(encodeLocalPluginStorageValue({ bad: Symbol('x') })).rejects.toThrow(/Symbols/)
        await expect(encodeLocalPluginStorageValue(Object(Symbol('x')))).rejects.toThrow(/Unsupported object type/)
    })

    it('rejects buffer types that cannot be snapshotted faithfully', async () => {
        await expect(encodeLocalPluginStorageValue(new SharedArrayBuffer(4)))
            .rejects.toThrow(/SharedArrayBuffer/)
        const resizable = new ArrayBuffer(4, { maxByteLength: 8 })
        await expect(encodeLocalPluginStorageValue(resizable)).rejects.toThrow(/Resizable ArrayBuffer/)
    })

    it('keeps stored bytes readable after a decoded view is transferred', async () => {
        const bytes = await encodeLocalPluginStorageValue({ view: new Uint8Array([4, 5, 6]) })
        const decoded = decodeLocalPluginStorageValue(bytes)

        structuredClone(decoded.view.buffer, { transfer: [decoded.view.buffer] })
        expect(Array.from(decodeLocalPluginStorageValue(bytes).view)).toEqual([4, 5, 6])
    })
})
