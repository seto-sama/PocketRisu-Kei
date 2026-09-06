import { expect, test } from 'vitest'
import { createRequire } from 'node:module'
import { spawnServer } from './helpers/spawnServer.js'
import { createClient } from './helpers/client.js'
import { createSeedBackup } from './helpers/seed.js'
import { decodeBackup } from './helpers/decode.js'
import { encodeBackup } from './helpers/encode.js'
import { decodeRisuDat } from './helpers/normalize.js'
import { defaultColorScheme } from '../../server/shared/colorScheme.js'

const require = createRequire(import.meta.url)
const { encodeRisuSaveLegacy } = require('../../server/node/utils.cjs')

test('backup endpoints serialize compatible active and saved colors without altering stored settings', async () => {
    const entries = decodeBackup(createSeedBackup())
    const databaseEntry = entries.find(entry => entry.name === 'database.risudat')!
    const db = decodeRisuDat(databaseEntry.data)
    const active = { ...defaultColorScheme, lightbg: '#123456', scoped: '#abcdef' }
    const saved = { ...defaultColorScheme, maintext: '#654321', warning: '#aabbcc' }
    db.colorScheme = active
    db.colorSchemeName = 'custom'
    db.themePresets = [{ name: 'Saved', colorScheme: saved, colorSchemeName: 'custom' }]
    databaseEntry.data = Buffer.from(encodeRisuSaveLegacy(db))
    const server = await spawnServer()
    try {
        const client = await createClient(server.port, server.password)
        expect((await client.importBackup(encodeBackup(entries))).ok).toBe(true)
        const readStored = async () => {
            const response = await client.fetch('/api/database')
            expect(response.ok).toBe(true)
            return response.json()
        }
        const before = await readStored()
        const check = (bytes: Buffer) => {
            const data = decodeRisuDat(decodeBackup(bytes).find(entry => entry.name === 'database.risudat')!.data) as any
            for (const [value, source] of [[data.colorScheme, active], [data.themePresets[0].colorScheme, saved]]) {
                expect(value).toMatchObject(source)
                for (const [alias, canonical] of Object.entries({ bgcolor: 'lightbg', borderc: 'lightborderc', darkBorderc: 'darkborderc', darkbutton: 'button', textcolor: 'maintext', textcolor2: 'subtext', draculared: 'danger' })) {
                    expect(value[alias]).toBe(source[canonical])
                }
            }
        }
        for (const query of ['', '?target=upstream', '?mode=settings', '?mode=settings&moduleAssets=0']) {
            const response = await client.fetch(`/api/backup/export${query}`)
            expect(response.ok).toBe(true)
            check(Buffer.from(await response.arrayBuffer()))
        }
        const save = await client.fetch('/api/backup/server/save', { method: 'POST' })
        expect(save.ok).toBe(true)
        const done = (await save.text()).trim().split('\n').map(line => JSON.parse(line)).find(event => event.type === 'done')
        expect(done?.ok).toBe(true)
        const download = await client.fetch(`/api/backup/server/download/${done.filename}`)
        expect(download.ok).toBe(true)
        check(Buffer.from(await download.arrayBuffer()))
        expect(await readStored()).toEqual(before)
    } finally { await server.cleanup() }
})
