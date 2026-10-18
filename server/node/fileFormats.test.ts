import { webcrypto } from 'node:crypto'
import { gzip, gunzip } from 'node:zlib'
import { promisify } from 'node:util'
import { decode as clientDecode, encode as clientEncode } from 'msgpackr/index-no-eval'
import { describe, expect, it } from 'vitest'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { encodeFile, decodeFile } = require('./fileFormats.cjs') as {
    encodeFile(format: string, value: unknown): Promise<Uint8Array>
    decodeFile(format: string, data: Uint8Array): Promise<any>
}
const apiErrorCodes = require('../../shared/apiErrorCodes.json')

const gzipAsync = promisify(gzip)
const gunzipAsync = promisify(gunzip)
const formats = {
    preset: { versionKey: 'presetVersion', version: 2, type: 'preset', password: 'risupreset' },
    theme: { versionKey: 'presetVersion', version: 1, type: 'theme', password: 'risutheme' },
    translator: { versionKey: 'translatorPresetVersion', version: 1, type: 'translator-preset', password: 'risutl' },
} as const

async function makeLegacyFile(format: keyof typeof formats, value: unknown, options: { raw?: boolean; version?: number; legacyKey?: boolean } = {}) {
    const config = formats[format]
    const keyBytes = await webcrypto.subtle.digest('SHA-256', new TextEncoder().encode(config.password))
    const key = await webcrypto.subtle.importKey('raw', keyBytes, 'AES-GCM', false, ['encrypt'])
    const encrypted = await webcrypto.subtle.encrypt(
        { name: 'AES-GCM', iv: new Uint8Array(12) },
        key,
        clientEncode(value),
    )
    const envelope = {
        [config.versionKey]: options.version ?? config.version,
        type: config.type,
        [format === 'preset' && options.legacyKey ? 'pres' : 'preset']: encrypted,
    }
    const compressed = await gzipAsync(clientEncode(envelope))
    if (options.raw) return compressed

    const map = require('node:fs').readFileSync('server/shared/rpack_map.bin') as Buffer
    return Uint8Array.from(compressed, byte => map[byte])
}

describe('server native file formats', () => {
    it('writes gzip-compatible RPack files that decode through the legacy AES-GCM envelope', async () => {
        const preset = { name: 'Fixture preset', prompt: 'Keep compatibility.' }
        const encoded = await encodeFile('preset', preset)
        const map = require('node:fs').readFileSync('server/shared/rpack_map.bin') as Buffer
        const compressed = Uint8Array.from(encoded, byte => map[256 + byte])
        expect(compressed.slice(0, 2)).toEqual(Uint8Array.of(0x1f, 0x8b))
        const envelope = clientDecode(await gunzipAsync(compressed))
        expect(envelope).toMatchObject({ presetVersion: 2, type: 'preset' })
        const keyBytes = await webcrypto.subtle.digest('SHA-256', new TextEncoder().encode('risupreset'))
        const key = await webcrypto.subtle.importKey('raw', keyBytes, 'AES-GCM', false, ['decrypt'])
        const plaintext = await webcrypto.subtle.decrypt(
            { name: 'AES-GCM', iv: new Uint8Array(12) },
            key,
            new Uint8Array(envelope.preset),
        )
        expect(clientDecode(plaintext)).toEqual(preset)
        expect(await decodeFile('preset', encoded)).toEqual(preset)
    })

    it('reads old raw-gzip and RPack preset containers, including the legacy field name', async () => {
        const rawPreset = { name: 'Raw preset', prompt: 'Old gzip container.' }
        const mappedPreset = { name: 'Mapped preset', prompt: 'Old RPack container.' }
        expect(await decodeFile('preset', await makeLegacyFile('preset', rawPreset, { raw: true }))).toEqual(rawPreset)
        expect(await decodeFile('preset', await makeLegacyFile('preset', mappedPreset, { version: 0, legacyKey: true }))).toEqual(mappedPreset)
    })

    it.each(['theme', 'translator'] as const)('reads legacy %s files', async format => {
        const value = { name: `${format} fixture`, prompt: 'Existing native format.' }
        expect(await decodeFile(format, await makeLegacyFile(format, value))).toEqual(value)
    })

    it('uses pretty JSON for the shared JSON codec', async () => {
        const value = { name: 'Readable', nested: { value: 1 } }
        const data = await encodeFile('json', value)
        expect(new TextDecoder().decode(data)).toBe(JSON.stringify(value, null, 2))
        expect(await decodeFile('json', data)).toEqual(value)
    })

    it('preserves the unsupported-remote code through the save codec', async () => {
        const name = Buffer.from('remote')
        const length = Buffer.alloc(4)
        const file = Buffer.concat([
            Buffer.from('RISUSAVE\0'),
            Buffer.from([6, 0, name.length]),
            name,
            length,
        ])
        await expect(decodeFile('save', file)).rejects.toMatchObject({
            code: apiErrorCodes.UNSUPPORTED_REMOTE_SAVE,
        })
    })
})
