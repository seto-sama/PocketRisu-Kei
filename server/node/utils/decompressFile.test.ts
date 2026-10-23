import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, expect, it } from 'vitest'

const { decompressFile } = require('./decompressFile.cjs') as {
    decompressFile: (compressedPath: string, destination: string) => Promise<void>
}
const execFileAsync = promisify(execFile)

let tempRoot = ''

afterEach(async () => {
    if (tempRoot) await rm(tempRoot, { recursive: true, force: true })
    tempRoot = ''
})

it('extracts a tar.gz when archive and destination paths contain spaces and quotes', async () => {
    tempRoot = await mkdtemp(join(tmpdir(), "pocketrisu archive's paths-"))
    const source = join(tempRoot, "source folder's files")
    const destination = join(tempRoot, "destination folder's files")
    const archivePath = join(tempRoot, "backup archive's copy.tar.gz")
    const expected = Buffer.from([0, 0x27, 0x20, 0xff, 0x80, 0x0a])
    await mkdir(source)
    await mkdir(destination)
    await writeFile(join(source, 'payload.bin'), expected)
    await execFileAsync('tar', ['-czf', archivePath, '-C', source, 'payload.bin'])

    await decompressFile(archivePath, destination)

    expect(await readFile(join(destination, 'payload.bin'))).toEqual(expected)
})

it('rejects a corrupt tar.gz archive', async () => {
    tempRoot = await mkdtemp(join(tmpdir(), "pocketrisu archive's corrupt-"))
    const destination = join(tempRoot, "destination folder's files")
    const archivePath = join(tempRoot, "corrupt archive's copy.tar.gz")
    await mkdir(destination)
    await writeFile(archivePath, 'not a gzip archive')

    await expect(decompressFile(archivePath, destination)).rejects.toBeDefined()
})
