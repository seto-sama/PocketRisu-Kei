import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'

const { IMAGE_TAG_SOURCE, createImageTagService } = createRequire(import.meta.url)('./imageTags.cjs')
const directories: string[] = []
const csv = 'long hair,0,100,"긴 머리, 장발"\r\n'
    + 'hair,0,50,"머리"\r\n'
    + 'hatsune miku,4,80,"미쿠: ""버추얼 싱어""\n캐릭터"\r\n'
    + 'toriyama_akira,1,20,토리야마 아키라\r\n'
    + 'touhou,3,40,동방프로젝트\r\n'
    + 'highres,5,200,고해상도\r\n'
const initialTime = 1_800_000_000_000
const day = 24 * 60 * 60 * 1000
const checksum = (text: string) => createHash('sha256').update(text).digest('hex')
function metadata(text = csv, revision = '1'.repeat(40), filename = 'with related tags/danbooru-tags-wrt-kr-2026-10-05.csv') {
    return { sha: revision, siblings: [{ rfilename: filename, size: Buffer.byteLength(text), lfs: { sha256: checksum(text) } }] }
}
async function directory() {
    const cacheDir = await mkdtemp(join(tmpdir(), 'risu-image-tags-'))
    directories.push(cacheDir)
    return cacheDir
}
function remote() {
    const state = { metadata: metadata(), body: csv, time: initialTime }
    const fetchImpl = vi.fn(async (url: string) => url === IMAGE_TAG_SOURCE.apiUrl
        ? Response.json(state.metadata) : new Response(state.body))
    return { state, fetchImpl, now: () => state.time }
}

afterEach(async () => {
    await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})

it('ranks name matches before description matches and parses quoted CSV fields', async () => {
    const service = createImageTagService({ cacheDir: await directory(), ...remote() })
    expect((await service.search('HAIR')).map(tag => tag.name)).toEqual(['hair', 'long hair'])
    expect((await service.search('long_hair'))[0].name).toBe('long hair')
    expect((await service.search('미쿠'))[0].description).toBe('미쿠: "버추얼 싱어"\n캐릭터')
})

it('suggests NovelAI V5 tags first, deferring to the dataset for names it already has', async () => {
    const { state, fetchImpl, now } = remote()
    state.body = csv + 'visual novel sprite,5,9,스탠딩\n'
    state.metadata = metadata(state.body)
    const service = createImageTagService({ cacheDir: await directory(), fetchImpl, now })
    expect((await service.search('high'))[0].name).toBe('high complexity')
    expect((await service.search('visual novel sprite')).filter(tag => tag.name === 'visual novel sprite'))
        .toEqual([expect.objectContaining({ count: 9 })])
})

it('downloads the latest related-tags CSV, ignoring plain, archived and variant files', async () => {
    const { state, fetchImpl, now } = remote()
    const file = state.metadata.siblings[0]
    state.metadata.siblings = [
        'with related tags/danbooru-tags-wrt-kr-2026-10-10-v2.csv',
        'with related tags/danbooru-tags-wrt-kr-2026-10-10-v10.csv',
        'with related tags/danbooru-tags-anima-wrt-kr-2026-12-31.csv',
        'danbooru-tags-kr-2026-12-31.csv',
        'old/2026-12-31/danbooru-tags-wrt-kr-2026-12-31.csv',
    ].map(rfilename => ({ ...file, rfilename }))
    await createImageTagService({ cacheDir: await directory(), fetchImpl, now }).search('hair')
    expect(fetchImpl.mock.calls[1][0]).toMatch(/\/with%20related%20tags\/danbooru-tags-wrt-kr-2026-10-10-v10\.csv$/)

    // Small files outside Git LFS carry a git blob hash instead of SHA-256.
    const blobId = createHash('sha1').update(`blob ${Buffer.byteLength(csv)}\0`).update(csv).digest('hex')
    state.metadata.siblings = [{ rfilename: 'with related tags/danbooru-tags-wrt-kr.csv', size: csv.length, blobId }]
    expect(await createImageTagService({ cacheDir: await directory(), fetchImpl, now }).search('hair')).not.toEqual([])
})

it('shares initial downloads and hydrates a fresh persistent cache offline after a restart', async () => {
    const cacheDir = await directory()
    const { fetchImpl, now } = remote()
    const service = createImageTagService({ cacheDir, fetchImpl, now })
    await expect(service.search('')).resolves.toEqual([])
    expect(fetchImpl).not.toHaveBeenCalled()
    const [english, korean] = await Promise.all([service.search('hair'), service.search('장발')])
    expect(english[0].name).toBe('hair')
    expect(korean[0].name).toBe('long hair')
    expect(fetchImpl).toHaveBeenCalledTimes(2)
    expect(await readFile(join(cacheDir, `${checksum(csv)}.csv`), 'utf8')).toBe(csv)

    const offlineFetch = vi.fn(() => { throw new Error('offline') })
    const restarted = createImageTagService({ cacheDir, fetchImpl: offlineFetch, now })
    expect((await restarted.search('미쿠'))[0].name).toBe('hatsune miku')
    expect(offlineFetch).not.toHaveBeenCalled()
})

it('rejects bad initial downloads, retries, and repairs a corrupt persistent cache', async () => {
    const cacheDir = await directory()
    const { state, fetchImpl, now } = remote()
    state.body = 'corrupt'
    const service = createImageTagService({ cacheDir, fetchImpl, now })
    await expect(service.search('hair')).rejects.toThrow('checksum mismatch')
    await expect(readFile(join(cacheDir, 'metadata.json'))).rejects.toMatchObject({ code: 'ENOENT' })
    state.body = csv
    expect((await service.search('hair'))[0].name).toBe('hair')

    await writeFile(join(cacheDir, `${checksum(csv)}.csv`), 'corrupt')
    const restarted = createImageTagService({ cacheDir, fetchImpl, now })
    expect((await restarted.search('hair'))[0].name).toBe('hair')
    expect(fetchImpl).toHaveBeenCalledTimes(6)
})

it('cancels an unsuccessful download body before retrying', async () => {
    const { fetchImpl, now } = remote()
    const cancel = vi.fn()
    fetchImpl.mockResolvedValueOnce(new Response(new ReadableStream({ cancel }), { status: 503 }))
    const service = createImageTagService({ cacheDir: await directory(), fetchImpl, now })
    await expect(service.search('hair')).rejects.toThrow('HTTP 503')
    expect(cancel).toHaveBeenCalledOnce()
    expect((await service.search('hair'))[0].name).toBe('hair')
})

it('checks once per day and keeps searches responsive while adopting a verified new filename', async () => {
    const cacheDir = await directory()
    const { state, fetchImpl, now } = remote()
    const service = createImageTagService({ cacheDir, fetchImpl, now })
    await service.search('hair')
    state.time += day - 1
    await service.search('hair')
    expect(fetchImpl).toHaveBeenCalledTimes(2)

    const updated = csv + 'new tag,0,10,새 태그\n'
    let resolveMetadata: (response: Response) => void
    fetchImpl.mockImplementationOnce(() => new Promise(resolve => { resolveMetadata = resolve }))
    state.time += 1
    state.body = updated
    expect((await service.search('hair'))[0].name).toBe('hair')
    expect(await service.search('new tag')).toEqual([])
    expect(fetchImpl).toHaveBeenCalledTimes(3)
    resolveMetadata!(Response.json(metadata(updated, '2'.repeat(40), 'with related tags/danbooru-tags-wrt-kr-2026-10-12-v2.csv')))
    await vi.waitFor(async () => expect((await service.search('new tag'))[0]?.name).toBe('new tag'))
    await vi.waitFor(async () => expect(JSON.parse(await readFile(join(cacheDir, 'metadata.json'), 'utf8')).source.revision).toBe('2'.repeat(40)))
})

it('replaces a cache from the retired plain CSV filename and removes its file', async () => {
    const cacheDir = await directory()
    const legacy = 'old tag,0,1,옛 태그\n'
    await writeFile(join(cacheDir, `${checksum(legacy)}.csv`), legacy)
    await writeFile(join(cacheDir, 'metadata.json'), JSON.stringify({ schemaVersion: 1, checkedAt: initialTime, source: {
        revision: '1'.repeat(40), filename: 'danbooru-tags-kr-2026-10-05.csv', algorithm: 'sha256', checksum: checksum(legacy),
    } }))
    const { fetchImpl, now } = remote()
    const service = createImageTagService({ cacheDir, fetchImpl, now })
    expect((await service.search('tag')).map(tag => tag.name)).not.toContain('old tag')
    expect(await readdir(cacheDir)).toEqual([`${checksum(csv)}.csv`, 'metadata.json'])
})

it('does not redownload an unchanged CSV when the dataset revision changes', async () => {
    const cacheDir = await directory()
    const { state, fetchImpl, now } = remote()
    const service = createImageTagService({ cacheDir, fetchImpl, now })
    await service.search('hair')
    state.metadata.sha = '2'.repeat(40)
    state.time += day
    await service.search('hair')
    await vi.waitFor(async () => expect(JSON.parse(await readFile(join(cacheDir, 'metadata.json'), 'utf8')).checkedAt).toBe(state.time))
    expect(fetchImpl).toHaveBeenCalledTimes(3)
    await service.search('hair')
    expect(fetchImpl).toHaveBeenCalledTimes(3)
})

it('preserves and throttles the last good cache after network or checksum failures, including restarts', async () => {
    const cacheDir = await directory()
    const { state, fetchImpl, now } = remote()
    const service = createImageTagService({ cacheDir, fetchImpl, now })
    await service.search('hair')
    state.time += day
    fetchImpl.mockRejectedValueOnce(new Error('offline'))
    expect((await service.search('hair'))[0].name).toBe('hair')
    await vi.waitFor(async () => expect(JSON.parse(await readFile(join(cacheDir, 'metadata.json'), 'utf8')).checkedAt).toBe(state.time))
    const restarted = createImageTagService({ cacheDir, fetchImpl, now })
    await restarted.search('hair')
    expect(fetchImpl).toHaveBeenCalledTimes(3)

    state.time += day
    state.metadata = metadata(csv + 'new tag,0,10,새 태그\n', '2'.repeat(40))
    state.body = 'corrupt'
    expect((await restarted.search('hair'))[0].name).toBe('hair')
    await vi.waitFor(async () => expect(JSON.parse(await readFile(join(cacheDir, 'metadata.json'), 'utf8')).checkedAt).toBe(state.time))
    expect(await restarted.search('new tag')).toEqual([])
    expect(fetchImpl).toHaveBeenCalledTimes(5)
    const saved = JSON.parse(await readFile(join(cacheDir, 'metadata.json'), 'utf8'))
    expect(saved.source.checksum).toBe(checksum(csv))
})
