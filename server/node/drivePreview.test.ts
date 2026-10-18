import { open, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, afterEach, it } from 'vitest'
import { strToU8, zipSync } from 'fflate'
import { readDrivePreview } from './drivePreview.cjs'

let directory = ''

afterEach(async () => {
    if (directory) await rm(directory, { recursive: true, force: true })
    directory = ''
})

async function withFile<T>(contents: Uint8Array, run: (handle: Awaited<ReturnType<typeof open>>) => Promise<T>): Promise<T> {
    directory = await mkdtemp(join(tmpdir(), 'drive-preview-'))
    const filePath = join(directory, 'preview-file')
    await writeFile(filePath, contents)
    const handle = await open(filePath, 'r')
    try {
        return await run(handle)
    } finally {
        await handle.close()
    }
}

function makeCharx(entries: Record<string, Uint8Array | string>) {
    return zipSync(Object.fromEntries(Object.entries(entries).map(([name, value]) => [
        name,
        typeof value === 'string' ? strToU8(value) : value,
    ])))
}

function cardWithAssets(assets: unknown[]) {
    return JSON.stringify({ spec: 'chara_card_v3', data: { assets } })
}

it('reads supported raster data through the supplied handle', async () => {
    const image = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3])
    await withFile(image, async handle => {
        expect(await readDrivePreview(handle, 'portrait.PNG', await handle.stat())).toEqual(image)
    })
})

it('extracts the card main icon even when image entries precede card.json', async () => {
    const mainIcon = Buffer.from('main icon bytes')
    const archive = makeCharx({
        'assets/unrelated.png': 'unrelated image',
        'assets/icons/main.webp': mainIcon,
        'card.json': cardWithAssets([
            { type: 'icon', name: 'emotion', uri: 'embeded://assets/unrelated.png' },
            { type: 'icon', name: 'main', uri: 'embeded://assets/icons/main.webp' },
        ]),
    })

    await withFile(archive, async handle => {
        expect(await readDrivePreview(handle, 'character.charx', await handle.stat())).toEqual(mainIcon)
    })
})

it('reads only ZIP metadata and the chosen icon when a CharX contains a large stored asset', async () => {
    const mainIcon = Buffer.from('main icon bytes')
    const archive = zipSync({
        'assets/unselected.bin': Buffer.alloc(2 * 1024 * 1024, 0x5a),
        'assets/icons/main.webp': mainIcon,
        'card.json': strToU8(cardWithAssets([
            { type: 'icon', name: 'main', uri: 'embeded://assets/icons/main.webp' },
        ])),
    }, { level: 0 })

    await withFile(archive, async handle => {
        let bytesRequested = 0
        let bytesRead = 0
        const countedHandle = {
            read: async (...args: Parameters<typeof handle.read>) => {
                bytesRequested += args[2]
                const result = await handle.read(...args)
                bytesRead += result.bytesRead
                return result
            },
        }

        expect(await readDrivePreview(countedHandle, 'large-character.charx', await handle.stat())).toEqual(mainIcon)
        expect(bytesRequested).toBeLessThan(256 * 1024)
        expect(bytesRead).toBeLessThan(256 * 1024)
    })
})

it('uses the first icon when the card has no main icon', async () => {
    const icon = Buffer.from('fallback icon')
    const archive = makeCharx({
        'assets/unrelated.png': 'unrelated image',
        'assets/icon.png': icon,
        'card.json': cardWithAssets([
            { type: 'icon', name: 'emotion', uri: 'embeded://assets/icon.png' },
        ]),
    })

    await withFile(archive, async handle => {
        expect(await readDrivePreview(handle, 'character.charx', await handle.stat())).toEqual(icon)
    })
})

it('returns null when there is no embedded card icon to preview', async () => {
    const archive = makeCharx({
        'assets/unrelated.png': 'unrelated image',
        'card.json': cardWithAssets([
            { type: 'icon', name: 'main', uri: 'https://example.invalid/avatar.png' },
        ]),
    })

    await withFile(archive, async handle => {
        expect(await readDrivePreview(handle, 'character.charx', await handle.stat())).toBeNull()
    })
})

it('returns null for truncated archives and raster files above the input cap', async () => {
    const archive = makeCharx({
        'assets/icon.png': 'icon',
        'card.json': cardWithAssets([
            { type: 'icon', name: 'main', uri: 'embeded://assets/icon.png' },
        ]),
    })
    const truncated = archive.subarray(0, archive.length - 5)
    await withFile(truncated, async handle => {
        expect(await readDrivePreview(handle, 'broken.charx', await handle.stat())).toBeNull()
    })

    await withFile(Buffer.from('too small to read under a fake oversized stat'), async handle => {
        expect(await readDrivePreview(handle, 'large.webp', { size: 50 * 1024 * 1024 + 1 })).toBeNull()
    })
})
