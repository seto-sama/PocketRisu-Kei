import { afterEach, describe, expect, it } from 'vitest'
import { access, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import pkg from './migrateCertificates.cjs'

const { migrateCertificates } = pkg
const directories: string[] = []
afterEach(async () => {
    await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})

describe('SSL certificate migration', () => {
    it('moves the complete legacy directory once and retains private key permissions', async () => {
        const root = await mkdtemp(join(tmpdir(), 'kei-ssl-'))
        directories.push(root)
        const legacy = join(root, 'server/node/ssl/certificate')
        await mkdir(legacy, { recursive: true })
        const files = { 'server.key': 'private key', 'server.crt': 'certificate', 'ca.key': 'CA key' }
        for (const [name, data] of Object.entries(files)) await writeFile(join(legacy, name), data, { mode: 0o600 })

        const destination = await migrateCertificates(root)
        expect(destination).toBe(join(root, 'server/ssl/certificate'))
        for (const [name, data] of Object.entries(files)) expect(await readFile(join(destination, name), 'utf8')).toBe(data)
        await expect(access(legacy)).rejects.toMatchObject({ code: 'ENOENT' })
        if (process.platform !== 'win32') expect((await stat(join(destination, 'server.key'))).mode & 0o777).toBe(0o600)
        await migrateCertificates(root)
        expect(await readFile(join(destination, 'server.key'), 'utf8')).toBe(files['server.key'])
    })

    it('keeps current certificates authoritative when both locations exist', async () => {
        const root = await mkdtemp(join(tmpdir(), 'kei-ssl-'))
        directories.push(root)
        const legacy = join(root, 'server/node/ssl/certificate')
        const current = join(root, 'server/ssl/certificate')
        for (const [directory, contents] of [[legacy, 'legacy key'], [current, 'current key']]) {
            await mkdir(directory, { recursive: true })
            await writeFile(join(directory, 'server.key'), contents)
        }

        await migrateCertificates(root)
        expect(await readFile(join(current, 'server.key'), 'utf8')).toBe('current key')
        expect(await readFile(join(legacy, 'server.key'), 'utf8')).toBe('legacy key')
    })
})
