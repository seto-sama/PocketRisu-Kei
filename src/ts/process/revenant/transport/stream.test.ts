import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
    decode: vi.fn(),
}))

vi.mock('../workflow/requestStatus', () => ({ observeRevenantWorkflowRequests: vi.fn() }))

vi.mock('./client', () => ({
    createRevenantCancellationHeaders: vi.fn(),
    createRevenantGenerationAuth: vi.fn(async () => 'auth'),
    getRevenantGenerationMetadata: vi.fn(),
    getRevenantGenerationSyncClientId: vi.fn(() => 'client'),
    setRevenantGenerationLocallyObserved: vi.fn(),
    trackRevenantGenerationJob: vi.fn(),
    trackRevenantGenerationWorkflow: vi.fn(),
}))

vi.mock('./journalSocket', () => ({
    openRevenantJournalSocket: vi.fn(() => new ReadableStream<Uint8Array>({
        start(controller) {
            controller.close()
        },
    })),
}))

vi.mock('./journalDecoder', () => ({
    decodeRevenantGenerationJournal: mocks.decode,
}))

import { subscribeRecoverableGeneration } from './stream'
import { openRevenantJournalSocket } from './journalSocket'
import type { RecoverableGenerationJob } from '../types'

const job: RecoverableGenerationJob = {
    jobId: 'job-1',
    chatId: 'message-1',
    status: 'generating',
    createdAt: 1,
    updatedAt: 2,
    streaming: true,
}

describe('subscribeRecoverableGeneration', () => {
    const snapshot = new TextEncoder().encode('snapshot')

    beforeEach(() => {
        vi.stubGlobal('fetch', vi.fn(async () => new Response(snapshot, {
            status: 200,
            headers: { 'x-risu-journal-offset': String(snapshot.length) },
        })))
    })

    afterEach(() => {
        vi.useRealTimers()
        mocks.decode.mockReset()
        vi.unstubAllGlobals()
    })

    it('coalesces a replay burst and flushes the latest projection before done', async () => {
        vi.useFakeTimers()
        mocks.decode.mockImplementation(async (_job, _stream, onContent, onProgress) => {
            for (const content of ['a', 'ab', 'abc']) {
                onProgress?.({ thinking: '', response: content })
                onContent?.(content)
            }
            return 'abc'
        })
        const onContent = vi.fn()
        const onProgress = vi.fn()
        const onDone = vi.fn()
        const onProviderStarted = vi.fn()

        subscribeRecoverableGeneration(job, { onContent, onProgress, onDone, onProviderStarted })
        await vi.advanceTimersByTimeAsync(0)
        const socketOptions = vi.mocked(openRevenantJournalSocket).mock.calls.at(-1)![0]
        socketOptions.onProviderStarted?.(123)
        expect(onProviderStarted).toHaveBeenCalledWith(123)

        expect(onContent.mock.calls.map(call => call[0])).toEqual(['abc'])
        expect(onProgress.mock.calls.map(call => call[0].response)).toEqual(['abc'])
        expect(onDone).toHaveBeenCalledOnce()
        expect(onContent.mock.invocationCallOrder.at(-1)).toBeLessThan(
            onDone.mock.invocationCallOrder[0],
        )
        expect(vi.getTimerCount()).toBe(0)
    })

    it('returns to unthrottled updates after reaching the live journal tail', async () => {
        mocks.decode.mockImplementation(async (_job, stream, onContent, onProgress) => {
            const reader = stream.getReader()
            await reader.read()
            for (const content of ['a', 'ab']) {
                onProgress?.({ thinking: '', response: content })
                onContent?.(content)
            }
            await reader.read()
            for (const content of ['abc', 'abcd']) {
                onProgress?.({ thinking: '', response: content })
                onContent?.(content)
            }
            return 'abcd'
        })
        const onContent = vi.fn()
        const onProgress = vi.fn()
        const onDone = vi.fn()

        subscribeRecoverableGeneration(job, { onContent, onProgress, onDone })
        await vi.waitFor(() => expect(onDone).toHaveBeenCalledOnce())

        expect(onContent.mock.calls.map(call => call[0])).toEqual(['ab', 'abc', 'abcd'])
        expect(onProgress.mock.calls.map(call => call[0].response)).toEqual([
            'ab', 'abc', 'abcd',
        ])
    })
})
