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
