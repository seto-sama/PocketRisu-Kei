import { describe, expect, it } from 'vitest'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { decodeRisuSave, encodeRisuSaveLegacy, magicRisuSaveHeader } = require('./utils.cjs')

function remoteSave(): Buffer {
    const name = Buffer.from('character-id', 'utf8')
    const payload = Buffer.from(JSON.stringify({
        v: 1,
        type: 2,
        name: 'character-id',
    }), 'utf8')
    const block = Buffer.alloc(2 + 1 + name.length + 4 + payload.length)
    block[0] = 6
    block[1] = 0
    block[2] = name.length
    name.copy(block, 3)
    block.writeUInt32LE(payload.length, 3 + name.length)
    payload.copy(block, 7 + name.length)
    return Buffer.concat([Buffer.from(magicRisuSaveHeader), block])
}

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
        await expect(decodeRisuSave(remoteSave())).rejects.toMatchObject({
            code: 'UNSUPPORTED_REMOTE_SAVE',
            message: expect.stringContaining('Disable Remote Saving in Original RisuAI'),
        })
    })
})
