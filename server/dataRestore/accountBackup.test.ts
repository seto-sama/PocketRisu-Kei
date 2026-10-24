import { describe, expect, it, vi } from 'vitest'
const { decryptAccountBackup } = require('./accountBackup.cjs')
const marker = Buffer.from(JSON.stringify({ type: 'account', time: 1788710000000 }))

describe('account backup key retrieval', () => {
    it('rejects invalid backup metadata before requesting a key', async () => {
        const fetchImpl = vi.fn()
        const invalid = Buffer.from(JSON.stringify({ type: 'account', time: '123' }))
        await expect(decryptAccountBackup(Buffer.alloc(16), invalid, { fetchImpl }))
            .rejects.toMatchObject({ code: 'BACKUP_ENCRYPTION_METADATA_INVALID' })
        expect(fetchImpl).not.toHaveBeenCalled()
    })

    it('reports a key-service rejection without exposing its response body', async () => {
        const fetchImpl = async () => new Response('private server response', { status: 403 })
        await expect(decryptAccountBackup(Buffer.alloc(16), marker, { fetchImpl })).rejects.toMatchObject({
            code: 'BACKUP_ENCRYPTION_KEY_UNAVAILABLE',
            message: expect.not.stringContaining('private server response'),
            details: { upstreamStatus: 403 },
        })
    })

    it('rejects a response without a usable backup key', async () => {
        await expect(decryptAccountBackup(Buffer.alloc(16), marker, { fetchImpl: async () => new Response('{}') }))
            .rejects.toMatchObject({ code: 'BACKUP_ENCRYPTION_KEY_UNAVAILABLE' })
    })
})
