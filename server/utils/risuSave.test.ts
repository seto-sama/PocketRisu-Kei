import { describe, expect, it } from 'vitest'
import { createRequire } from 'node:module'
import { deflateRawSync, deflateSync, gzipSync } from 'node:zlib'
import { encodeRisuSaveBlocks } from '../../test/compat/helpers/encode'

const require = createRequire(import.meta.url)
const {
    decodeRisuSave,
    encodeRisuSave,
    encodeRisuSaveLegacy,
} = require('./risuSave.cjs')
const magicHeader = Uint8Array.of(0, 82, 73, 83, 85, 83, 65, 86, 69, 0, 7)
const magicCompressedHeader = Uint8Array.of(0, 82, 73, 83, 85, 83, 65, 86, 69, 0, 8)
const magicStreamCompressedHeader = Uint8Array.of(0, 82, 73, 83, 85, 83, 65, 86, 69, 0, 9)

describe('decodeRisuSave', () => {
    it('assigns legacy preset IDs and rejects duplicate persona IDs during decode', async () => {
        const decoded = await decodeRisuSave(encodeRisuSaveLegacy({
            characters: [], botPresets: [{ name: 'Legacy' }], personas: [{ id: 'existing', name: 'Persona' }],
        }))
        expect(decoded.botPresets[0].id).toEqual(expect.any(String))
        expect(decoded.personas[0].id).toBe('existing')

        await expect(decodeRisuSave(encodeRisuSaveLegacy({
            characters: [], personas: [{ id: 'duplicate' }, { id: 'duplicate' }],
        }))).rejects.toThrow('personas: Duplicate entity ID: duplicate')
    })

    it('rejects REMOTE saves with actionable conversion guidance', async () => {
        await expect(decodeRisuSave(encodeRisuSaveBlocks([{
            type: 6, name: 'character-id', data: Buffer.from(JSON.stringify({ v: 1, type: 2, name: 'character-id' })),
        }]))).rejects.toMatchObject({
            code: 'UNSUPPORTED_REMOTE_SAVE',
            message: expect.stringContaining('Disable Remote Saving in RisuAI'),
        })
    })

    it('leaves missing preset defaults to the client database normalizer', async () => {
        const decoded = await decodeRisuSave(encodeRisuSaveBlocks([{ type: 1, name: 'root', data: Buffer.from('{}') }]))

        expect(decoded.characters).toEqual([])
        expect(decoded).not.toHaveProperty('botPresets')
        expect(decoded.botPresetsId).toBe(0)
    })

    it('reports processed bytes while compressing compatible portable saves', async () => {
        const database = { characters: [], language: 'ko', globalNote: '백업 데이터'.repeat(100_000) }
        const progress: Array<[number, number]> = []
        const encoded = await encodeRisuSave(database, (bytes: number, total: number) => progress.push([bytes, total]))

        expect(Array.from(encoded.subarray(0, magicCompressedHeader.length))).toEqual(Array.from(magicCompressedHeader))
        expect(Array.from(encoded.subarray(magicCompressedHeader.length, magicCompressedHeader.length + 2))).toEqual([0x1f, 0x8b])
        const total = progress.at(-1)![1]
        expect(progress[0]).toEqual([0, total])
        expect(progress.at(-1)).toEqual([total, total])
        expect(progress.some(([bytes]) => bytes > 0 && bytes < total)).toBe(true)
        expect(progress.every(([bytes, size], i) => size === total && bytes >= (progress[i - 1]?.[0] ?? 0))).toBe(true)
        await expect(decodeRisuSave(encoded)).resolves.toMatchObject(database)
    })

    it.each([
        ['gzip', (payload: Buffer) => gzipSync(payload)],
        ['zlib', (payload: Buffer) => deflateSync(payload)],
        ['raw deflate', (payload: Buffer) => deflateRawSync(payload)],
    ] as const)('keeps decoding %s framed compressed saves', async (_format, compress) => {
        const database = { characters: [], language: 'ko' }
        const rawPayload = Buffer.from(encodeRisuSaveLegacy(database)).subarray(magicHeader.length)
        const compressed = compress(rawPayload)
        const encoded = Buffer.concat([Buffer.from(magicCompressedHeader), compressed])

        await expect(decodeRisuSave(encoded)).resolves.toMatchObject(database)
    })

    it('keeps valid data when a compressed plugin block is corrupt', async () => {
        const data = encodeRisuSaveBlocks([
            { type: 1, name: 'root', data: Buffer.from('{}') },
            { type: 11, name: 'pluginStorage', compressed: true, data: gzipSync(Buffer.from('{"key":"value"}')) },
            { type: 11, name: 'pluginStorage', compressed: true, data: Buffer.from('bad gzip') },
        ])
        await expect(decodeRisuSave(data)).resolves.toMatchObject({ pluginCustomStorage: { key: 'value' } })
    })

    it('decodes gzip stream-header saves', async () => {
        const database = { characters: [], language: 'ko' }
        const rawPayload = Buffer.from(encodeRisuSaveLegacy(database)).subarray(magicHeader.length)
        const encoded = Buffer.concat([Buffer.from(magicStreamCompressedHeader), gzipSync(rawPayload)])

        await expect(decodeRisuSave(encoded)).resolves.toMatchObject(database)
    })
})
