import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

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

import { subscribeRecoverableGeneration, fetchViaGenerationJob } from './stream'
import { decodeGenerationRequest, BINARY_MESSAGE_CONTENT_TYPE } from './protocol'
import { openRevenantJournalSocket } from './journalSocket'
import { encodeDecodedChatEvent } from '../../../preset/adapter/decodedEvents'
import type { RecoverableGenerationJob } from '../types'

const deltas = (...texts: string[]) => new TextEncoder().encode(texts
    .map(textDelta => encodeDecodedChatEvent({ type: 'delta', delta: { textDelta } }))
    .join(''))

const job: RecoverableGenerationJob = {
    jobId: 'job-1',
    chatId: 'message-1',
    status: 'generating',
    createdAt: 1,
    updatedAt: 2,
}

describe('generation job registration', () => {
    afterEach(() => vi.unstubAllGlobals())

    it('posts metadata and exact binary body, then observes the created job', async () => {
        const fetchMock = vi.fn(async () => new Response(JSON.stringify({ jobId: 'created', createdAt: 123 })))
        vi.stubGlobal('fetch', fetchMock)
        vi.mocked(openRevenantJournalSocket).mockImplementationOnce(options => {
            queueMicrotask(() => options.onHeaders?.(200, { 'content-type': 'application/json' }))
            return new ReadableStream({ start(controller) { controller.close() } })
        })
        const body = Uint8Array.of(0, 128, 255, 0xea, 0xb0)
        const response = await fetchViaGenerationJob('https://provider.example', {
            method: 'POST', headers: { authorization: 'test-key' }, body,
            generationRequest: { job: { jobType: 'otherAx', chatId: 'request' } },
        })
        expect(response.status).toBe(200)
        const [url, init] = vi.mocked(fetch).mock.calls[0]
        expect(url).toBe('/api/generation/jobs')
        expect(init?.headers['Content-Type']).toBe(BINARY_MESSAGE_CONTENT_TYPE)
        expect(decodeGenerationRequest(init?.body as Uint8Array)).toMatchObject({
            url: 'https://provider.example', method: 'POST',
            headers: { authorization: 'test-key' }, body, jobType: 'otherAx',
        })
        expect(vi.mocked(openRevenantJournalSocket).mock.calls.at(-1)?.[0].jobId).toBe('created')
    })
})

describe('subscribeRecoverableGeneration', () => {
    const snapshotWith = (snapshot: Uint8Array) => vi.stubGlobal('fetch', vi.fn(async () => new Response(snapshot as BodyInit, {
        status: 200,
        headers: { 'x-risu-journal-offset': String(snapshot.length) },
    })))

    afterEach(() => {
        vi.useRealTimers()
        vi.unstubAllGlobals()
    })

    it('coalesces a replayed snapshot and flushes the latest projection before done', async () => {
        vi.useFakeTimers()
        snapshotWith(deltas('a', 'b', 'c'))
        const onContent = vi.fn()
        const onProgress = vi.fn()
        const onDone = vi.fn()
        const onProviderStarted = vi.fn()

        subscribeRecoverableGeneration(job, { onContent, onProgress, onDone, onProviderStarted })
        await vi.advanceTimersByTimeAsync(0)
        const socketOptions = vi.mocked(openRevenantJournalSocket).mock.calls.at(-1)![0]
        expect(socketOptions).toMatchObject({ format: 'events', initialOffset: deltas('a', 'b', 'c').length })
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
        snapshotWith(deltas('a', 'b'))
        vi.mocked(openRevenantJournalSocket).mockImplementationOnce(() => new ReadableStream({
            start(controller) {
                // A live chunk can split an event line.
                const live = deltas('c', 'd')
                controller.enqueue(live.subarray(0, 10))
                controller.enqueue(live.subarray(10))
                controller.close()
            },
        }))
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
