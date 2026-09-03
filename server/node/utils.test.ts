import { describe, expect, it } from 'vitest'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { decodeRisuSave, magicRisuSaveHeader } = require('./utils.cjs')

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
    it('rejects REMOTE saves with actionable conversion guidance', async () => {
        await expect(decodeRisuSave(remoteSave())).rejects.toMatchObject({
            code: 'UNSUPPORTED_REMOTE_SAVE',
            message: expect.stringContaining('Disable Remote Saving in Original RisuAI'),
        })
    })
})
