import { afterEach, describe, expect, test, vi } from 'vitest'

const { workflowState } = vi.hoisted(() => ({
    workflowState: { workflow: undefined as undefined | { workflowId: string } },
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

import { buildGenerationRequest, collectStreamingText, ensureRequestGenerationId, getRequestStatusNavigationId } from './shared'

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
    test('shares one id between an auxiliary status and its durable job', () => {
        const arg = {
            formated: [],
            bias: {},
            mode: 'memory' as const,
            revenantRequestId: undefined as string | undefined,
        }

        const request = buildGenerationRequest(arg)

        expect(request?.job.chatId).toMatch(/^aux-/)
        expect(ensureRequestGenerationId(arg)).toBe(request?.job.chatId)
        expect(buildGenerationRequest(arg)?.job.chatId).toBe(request?.job.chatId)
    })

    test('captures the submitted room as the auxiliary toast navigation target', () => {
        const arg = {
            formated: [],
            bias: {},
            mode: 'memory' as const,
            currentChar: {
                chaId: 'character-1',
                chatPage: 0,
                chats: [{ id: 'submitted-room', message: [] }],
            },
        } as any

        buildGenerationRequest(arg)

        expect(arg.revenantRoomId).toBe('submitted-room')
        expect(getRequestStatusNavigationId(arg)).toBe('submitted-room')
    })

    test('targets the translated message more precisely than its room', () => {
        expect(getRequestStatusNavigationId({
            formated: [],
            bias: {},
            revenantRoomId: 'room-1',
            revenantOperationContext: {
                kind: 'translation',
                operationId: 'translation-1',
                cacheKey: 'cache-1',
                styleDecodes: [],
                replaceExisting: false,
                target: {
                    kind: 'chat-message',
                    messageChatId: 'message-1',
                    messageIndex: 1,
                    swipeId: 0,
                },
            },
        })).toBe('message-1')
    })

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
        workflowState.workflow = { workflowId: 'workflow-1' }
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
        })
        expect(first?.workflow?.executionId).toBeTruthy()
        expect(second?.workflow?.executionId).toBe(first?.workflow?.executionId)
    })

    test('keeps main generation ownership on the submitted room after navigation', () => {
        const request = buildGenerationRequest({
            formated: [],
            bias: {},
            mode: 'model',
            chatId: 'message-1',
            currentChar: {
                chaId: 'character-1',
                // The UI has already moved away from the submitted room.
                chatPage: 1,
                chats: [
                    { id: 'submitted-room', message: [{ role: 'char', data: 'submitted prefix' }] },
                    { id: 'visible-room', message: [{ role: 'char', data: 'visible prefix' }] },
                ],
            },
            continue: true,
            revenantRoomId: 'submitted-room',
            revenantContinuationPrefix: 'submitted prefix',
        } as any)

        expect(request?.job).toMatchObject({
            characterId: 'character-1',
            roomId: 'submitted-room',
            continuationPrefix: 'submitted prefix',
        })
    })

    test('links a delegated client action to its parent step', () => {
        workflowState.workflow = { workflowId: 'workflow-1' }
        const request = buildGenerationRequest({
            formated: [], bias: {}, mode: 'model',
            currentChar: {
                chaId: 'character-1', chatPage: 0,
                chats: [{ id: 'room-1', message: [] }],
            },
            revenantClientAction: {
                workflowId: 'workflow-1',
                parentStepKey: 'trigger.output',
                actionId: 'trigger.0.provider.llm',
                executionId: 'action-execution-1',
            },
        } as any)

        expect(request?.workflow).toEqual({
            workflowId: 'workflow-1',
            stepKey: 'client-action:trigger.0.provider.llm',
            executionId: 'action-execution-1',
            clientAction: {
                parentStepKey: 'trigger.output',
                actionId: 'trigger.0.provider.llm',
            },
        })
    })

    test('links a delegated main plugin dispatch to model.main', () => {
        workflowState.workflow = { workflowId: 'workflow-1' }
        const request = buildGenerationRequest({
            formated: [], bias: {}, mode: 'model', chatId: 'message-1',
            currentChar: {
                chaId: 'character-1', chatPage: 0,
                chats: [{ id: 'room-1', message: [] }],
            },
            revenantClientAction: {
                workflowId: 'workflow-1',
                parentStepKey: 'model.dispatch',
                actionId: 'model.dispatch.plugin',
                executionId: 'action-execution-1',
                jobStepKey: 'model.main',
            },
        } as any)

        expect(request?.job.jobType).toBe('model')
        expect(request?.workflow).toEqual({
            workflowId: 'workflow-1',
            stepKey: 'model.main',
            executionId: 'action-execution-1',
            clientAction: {
                parentStepKey: 'model.dispatch',
                actionId: 'model.dispatch.plugin',
            },
        })
    })
})
