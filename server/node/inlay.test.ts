import { afterEach, expect, test, vi } from 'vitest'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import Vips from 'wasm-vips'
import inlays from './inlay.cjs'

let directory: string
afterEach(async () => { if (directory) await rm(directory, { recursive: true, force: true }) })

test('shares thumbnail builds, retries failures, and cleans up a build completed during deletion', async () => {
    directory = await mkdtemp(path.join(tmpdir(), 'inlay-cache-'))
    const started = Promise.withResolvers<void>()
    const resume = Promise.withResolvers<void>()
    const getVips = vi.fn()
        .mockRejectedValueOnce(new Error('Temporary decoder initialization failure'))
        .mockImplementationOnce(() => Vips())
        .mockImplementation(async () => {
            started.resolve()
            await resume.promise
            return Vips()
        })
    const service = inlays.createInlayService({
        inlayDir: directory, getVips, getMimeFromExt: () => 'image/png',
        kvGet: () => null, kvDel: () => {}, kvList: () => [], logger: { warn: vi.fn() },
    })
    const image = Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l7sAAAAASUVORK5CYII=',
        'base64',
    )
    await service.writeInlayFile('image', 'png', image, { type: 'image' })

    expect(await Promise.all(Array.from({ length: 3 }, () => service.ensureThumbnail('image', 'image'))))
        .toEqual([null, null, null])
    expect(getVips).toHaveBeenCalledTimes(1)

    const thumbnails = await Promise.all(Array.from({ length: 3 }, () => service.ensureThumbnail('image', 'image')))
    expect(thumbnails.every(thumbnail => thumbnail !== null)).toBe(true)
    const cached = await service.ensureThumbnail('image', 'image')
    expect(cached.filePath).toBe(thumbnails[0].filePath)
    expect(getVips).toHaveBeenCalledTimes(2)

    await service.writeInlayFile('image', 'png', image, { type: 'image' })
    const requests = Array.from({ length: 3 }, () => service.ensureThumbnail('image', 'image'))
    await started.promise
    const deletion = service.deleteInlayFile('image')
    resume.resolve()
    await Promise.all(requests)
    await deletion
    expect(getVips).toHaveBeenCalledTimes(3)
    expect(await readdir(path.join(directory, '.image-thumbnails'))).toEqual([])
    expect(await service.ensureThumbnail('image', 'image')).toBeNull()
})

test('removes unsupported legacy inlays and hides unsupported file-backed assets', async () => {
    directory = await mkdtemp(path.join(tmpdir(), 'inlay-media-types-'))
    const values = new Map<string, Buffer>([
        ['inlay/legacy-signature', Buffer.from(JSON.stringify({
            type: 'signature', ext: 'json', data: 'data:application/json;base64,e30=',
        }))],
        ['inlay_info/legacy-signature', Buffer.from(JSON.stringify({ type: 'signature', ext: 'json' }))],
        ['inlay_thumb/legacy-signature', Buffer.from('thumbnail')],
    ])
    const service = inlays.createInlayService({
        inlayDir: directory,
        getVips: async () => Vips(),
        getMimeFromExt: ext => ext === 'png' ? 'image/png' : 'application/json',
        kvGet: key => values.get(key) ?? null,
        kvDel: key => values.delete(key),
        kvList: prefix => [...values.keys()].filter(key => key.startsWith(prefix)),
        logger: { warn: vi.fn() },
    })
    const image = Buffer.from('image-bytes')
    await service.writeInlayFile('file-signature', 'json', Buffer.from('opaque signature'), { type: 'signature' })
    await service.writeInlayFile('supported-image', 'png', image, { type: 'image' })

    await service.migrateInlaysToFilesystem()

    expect([...values.keys()]).toEqual([])
    expect((await service.listInlayFiles()).map(entry => entry.id)).toEqual(['supported-image'])
    expect(await service.getInlayFileInfo('file-signature')).toBeNull()
    expect(await service.readInlayAssetPayload('file-signature')).toBeNull()
    expect(await service.readInlayInfoPayload('file-signature')).toBeNull()

    const payload = await service.readInlayAssetPayload('supported-image')
    expect(payload).not.toBeNull()
    expect(service.decodeInlayAsset(payload).bytes).toEqual(image)
    expect(JSON.parse((await service.readInlayInfoPayload('supported-image')).toString()).type)
        .toBe('image')

    await service.deleteInlayFile('file-signature')
    const remaining = await readdir(directory)
    expect(remaining).not.toContain('file-signature.json')
    expect(remaining).not.toContain('file-signature.meta.json')
})
