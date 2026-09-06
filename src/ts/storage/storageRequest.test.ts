import { describe, expect, it, vi } from 'vitest'
import { ChatSaveError, SaveConflictError, SaveRetryPolicy, isRetryableSaveError, storageRequestError, StorageRequestError } from './storageRequest'

describe('storage error details', () => {
    it('preserves server JSON and plain-text errors with bounded display text', async () => {
        const json = await storageRequestError('save', new Response(JSON.stringify({ error: 'disk full' }), { status: 500 }))
        expect(json).toMatchObject({ operation: 'save', status: 500, serverMessage: 'disk full' })
        expect(json.message).toContain('HTTP 500')
        expect(json.message).toContain('disk full')

        const plain = await storageRequestError('save', new Response('unavailable\n' + 'x'.repeat(2000), { status: 503 }))
        expect(plain.serverMessage).toHaveLength(512)
        expect(plain.serverMessage).toMatch(/^unavailable x/)
    })

    it('explains proxy 413 responses without displaying the HTML page', async () => {
        const error = await storageRequestError('save', new Response('<html>nginx body limit</html>', {
            status: 413, headers: { 'content-type': 'text/html' },
        }))
        expect(error.message).toContain('HTTP 413')
        expect(error.message).toContain('request-size limit')
        expect(error.message).not.toContain('<html>')
        expect(isRetryableSaveError(error)).toBe(false)
    })

    it('retains failed targets, acknowledged projection state and the original chat error', () => {
        const cause = new StorageRequestError('saveChatContent', 413)
        const error = new ChatSaveError([['character', 'chat']], true, [cause])
        expect(error.failedChats).toEqual([['character', 'chat']])
        expect(error.projectionSaved).toBe(true)
        expect(error.cause).toBe(cause)
        expect(error.message).toContain(cause.message)
        expect(isRetryableSaveError(error)).toBe(false)
        expect(isRetryableSaveError(new ChatSaveError([['a', 'b']], false, [new TypeError('Failed to fetch')]))).toBe(true)
    })

    it('shows the permanent failure when a batch also has a transient failure', () => {
        const temporary = new StorageRequestError('saveChatContent', 503, 'unavailable')
        const oversized = new StorageRequestError('saveChatContent', 413)
        const error = new ChatSaveError([['a', '1'], ['a', '2']], true, [temporary, oversized])
        expect(error.cause).toBe(oversized)
        expect(error.message).toContain('HTTP 413')
        expect(isRetryableSaveError(error)).toBe(false)
        expect(isRetryableSaveError(temporary)).toBe(true)
    })

})

describe('automatic save retry policy', () => {
    it('bounds repeated rebase outcomes and mixed transport failures in one budget', async () => {
        const policy = new SaveRetryPolicy()
        const rebase = vi.fn(async () => 'retry' as const)
        const send = vi.fn()
            .mockImplementationOnce(rebase)
            .mockRejectedValueOnce(new TypeError('Failed to fetch'))
            .mockImplementation(rebase)
        let stopped: unknown
        for (let attempt = 0; attempt < 20; attempt++) {
            try {
                await policy.runAttempt(send)
            } catch (error) {
                const decision = policy.recordFailure(error)
                if (!decision.retry) { stopped = error; break }
                expect(decision.delayMs).toBeGreaterThan(0)
            }
        }
        expect(send).toHaveBeenCalledTimes(5)
        expect(rebase).toHaveBeenCalledTimes(4)
        expect(stopped).toBeInstanceOf(SaveConflictError)
    })

    it('resets after an acknowledged save or a new attempt after stopping, not a noop', async () => {
        const policy = new SaveRetryPolicy()
        const failure = new TypeError('network')
        for (let i = 0; i < 4; i++) expect(policy.recordFailure(failure).retry).toBe(true)
        await policy.runAttempt(async () => 'noop')
        expect(policy.recordFailure(failure).retry).toBe(false)
        policy.reset()
        expect(policy.recordFailure(failure).delayMs).toBe(500)
        await policy.runAttempt(async () => 'saved')
        expect(policy.recordFailure(failure).delayMs).toBe(500)
        expect(policy.recordFailure(new StorageRequestError('patchDatabase', 413)).retry).toBe(false)
    })
})
