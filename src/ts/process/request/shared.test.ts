import { afterEach, describe, expect, test, vi } from 'vitest'

const { workflowState } = vi.hoisted(() => ({
    workflowState: { workflow: undefined as undefined | { workflowId: string, ownerEpoch: number } },
}))

// shared.ts imports getDatabase at module load; stub it so this pure-helper test
// stays off the big database import graph (mirrors modelPresetBinding.test.ts).
vi.mock('src/ts/storage/database.svelte', () => ({
    getDatabase: () => ({}),
}))
vi.mock('../revenant/workflow', () => ({
    getLocalRevenantWorkflow: () => workflowState.workflow,
    getRevenantWorkflowStepKey: (jobType: string) => jobType === 'model' ? 'model.main' : `job.${jobType}`,
}))

import { buildGenerationRequest, collectStreamingText } from './shared'

afterEach(() => {
    workflowState.workflow = undefined
})

// collectStreamingText underpins per-preset decoupled streaming: the wire stays
// SSE, but the stream is drained to a single string. Every chunk carries the
// FULL accumulated text in its first key, so draining must return the LAST
// chunk's first-key value (not a concatenation of deltas).

function streamOf(chunks: Array<{ [key: string]: string }>): ReadableStream<{ [key: string]: string }> {
    return new ReadableStream({
        start(controller) {
            for (const chunk of chunks) controller.enqueue(chunk)
            controller.close()
        },
    })
}

describe('collectStreamingText', () => {
    test('returns the last chunk because chunks are cumulative, not deltas', async () => {
        const stream = streamOf([{ '0': 'He' }, { '0': 'Hello' }, { '0': 'Hello world' }])
        expect(await collectStreamingText(stream)).toBe('Hello world')
    })

    test('preserves a reasoning-prefixed final chunk verbatim', async () => {
        const final = '<Thoughts>\nthinking\n</Thoughts>\n\nanswer'
        const stream = streamOf([{ '0': '<Thoughts>' }, { '0': final }])
        expect(await collectStreamingText(stream)).toBe(final)
    })

    test('reads the first key only (multiGen sidecar indices are ignored)', async () => {
        const stream = streamOf([{ '0': 'main', '1': 'second' }])
        expect(await collectStreamingText(stream)).toBe('main')
    })

    test('returns empty string for an empty stream', async () => {
        const stream = streamOf([])
        expect(await collectStreamingText(stream)).toBe('')
    })
})

describe('buildGenerationRequest', () => {
    test('forwards the durable registration lifecycle callbacks', () => {
        const onJobCreated = vi.fn()
        const onJobRegistrationUnavailable = vi.fn()
        const onProviderStarted = vi.fn()

        const request = buildGenerationRequest({
            formated: [],
            bias: {},
            mode: 'model',
            chatId: 'message-1',
            onRevenantJobCreated: onJobCreated,
            onRevenantJobRegistrationUnavailable: onJobRegistrationUnavailable,
            onRevenantProviderStarted: onProviderStarted,
        })

        expect(request?.lifecycle?.onJobCreated).toBe(onJobCreated)
        expect(request?.lifecycle?.onJobRegistrationUnavailable).toBe(onJobRegistrationUnavailable)
        expect(request?.lifecycle?.onProviderStarted).toBe(onProviderStarted)
        expect(request?.job).not.toHaveProperty('onJobCreated')
        expect(request?.job).not.toHaveProperty('workflowId')
        expect(request?.workflow).toBeUndefined()
    })

    test('reuses one step execution id across every provider round', () => {
        workflowState.workflow = { workflowId: 'workflow-1', ownerEpoch: 3 }
        const arg = {
            formated: [],
            bias: {},
            mode: 'model' as const,
            chatId: 'message-1',
            currentChar: {
                chaId: 'character-1',
                chatPage: 0,
                chats: [{ id: 'room-1', message: [] }],
            },
        } as any

        const first = buildGenerationRequest(arg)
        const second = buildGenerationRequest(arg)

        expect(first?.workflow).toMatchObject({
            workflowId: 'workflow-1',
            stepKey: 'model.main',
            ownerEpoch: 3,
        })
        expect(first?.workflow?.executionId).toBeTruthy()
        expect(second?.workflow?.executionId).toBe(first?.workflow?.executionId)
    })
})
