import { afterEach, describe, expect, it, vi } from 'vitest'
import { get } from 'svelte/store'
import type { RevenantWorkflow } from '../types'
import {
    activeRevenantWorkflows,
    beginImageGenerationWorkflow,
    beginRevenantWorkflow,
    cancelRevenantWorkflow,
    completeChatGenerationPreModelPlan,
    createChatGenerationWorkflowPlan,
    createRevenantWorkflowResumeMetadata,
    getActiveRevenantWorkflow,
    getRevenantWorkflow,
    getRevenantWorkflowResumeContext,
    RevenantWorkflowBusyError,
} from './workflow'
import {
    configureRevenantGenerationClient,
    createRevenantJobMutationHeaders,
    trackRevenantGenerationWorkflow,
} from '../transport/client'

function workflowWithMetadata(metadata?: Record<string, unknown>): RevenantWorkflow {
    return {
        workflowId: 'workflow-1',
        characterId: 'character-1',
        roomId: 'room-1',
        planVersion: 1,
        status: 'active',
        createdAt: 1,
        updatedAt: 1,
        steps: [{
            key: 'prompt.build',
            kind: 'prompt.build',
            recoveryPolicy: 'resume',
            status: 'pending',
            order: 0,
            metadata,
            updatedAt: 1,
            executions: [],
        }],
    }
}

configureRevenantGenerationClient({
    createAuth: async () => 'auth',
    getSyncClientId: () => 'client-1',
})

afterEach(() => {
    vi.unstubAllGlobals()
})

describe('revenant workflow resume checkpoint', () => {
    it('orders chat generation as preprocess, durable model, postprocess, materialize', () => {
        const plan = createChatGenerationWorkflowPlan({
            resumeContext: {
                version: 1,
                chatProcessIndex: -1,
                messageChatId: 'message-1',
                continue: false,
            },
            hypaEnabled: false,
            igpEnabled: true,
            pluginProvider: false,
        })

        expect(plan.map(step => step.key)).toEqual([
            'input.commit',
            'trigger.start',
            'memory.hypav3',
            'prompt.build',
            'model.dispatch',
            'model.main',
            'output.transform',
            'trigger.output',
            'igp',
            'postprocess',
            'message.materialize',
        ])
        expect(plan.find(step => step.key === 'memory.hypav3')?.status).toBe('skipped')
        expect(plan.find(step => step.key === 'model.dispatch')?.status).toBe('skipped')
        expect(plan.find(step => step.key === 'message.materialize')?.recoveryPolicy).toBe('resume')
    })

    it('waits for a browser dispatch only for plugin providers', () => {
        const plan = createChatGenerationWorkflowPlan({
            resumeContext: {
                version: 1,
                chatProcessIndex: -1,
                messageChatId: 'message-1',
                continue: false,
            },
            hypaEnabled: false,
            igpEnabled: false,
            pluginProvider: true,
        })

        expect(plan.find(step => step.key === 'model.dispatch')?.status).toBe('pending')
    })

    it('publishes a workflow only after local prompt preprocessing is complete', () => {
        const plan = completeChatGenerationPreModelPlan(createChatGenerationWorkflowPlan({
            resumeContext: {
                version: 1,
                chatProcessIndex: -1,
                messageChatId: 'message-1',
                continue: false,
            },
            hypaEnabled: false,
            igpEnabled: false,
            pluginProvider: false,
        }))

        expect(plan.find(step => step.key === 'input.commit')?.status).toBeUndefined()
        expect(plan.find(step => step.key === 'trigger.start')?.status).toBe('completed')
        expect(plan.find(step => step.key === 'memory.hypav3')?.status).toBe('skipped')
        expect(plan.find(step => step.key === 'prompt.build')?.status).toBe('completed')
        expect(plan.find(step => step.key === 'model.main')?.status).toBeUndefined()
    })

    it('keeps server-planned Hypa pending while marking local prompt assembly complete', () => {
        const plan = completeChatGenerationPreModelPlan(createChatGenerationWorkflowPlan({
            resumeContext: { version: 1, chatProcessIndex: -1, messageChatId: 'message', continue: false },
            hypaEnabled: true, igpEnabled: false, pluginProvider: false,
        }), true)
        expect(plan.find(step => step.key === 'memory.hypav3')?.status).toBe('pending')
        expect(plan.find(step => step.key === 'prompt.build')?.status).toBe('completed')
    })

    it('round-trips the stable main message identity and invocation mode', () => {
        const metadata = createRevenantWorkflowResumeMetadata({
            version: 1,
            chatProcessIndex: -1,
            messageChatId: 'message-1',
            continue: true,
        })

        expect(getRevenantWorkflowResumeContext(workflowWithMetadata(metadata))).toEqual({
            version: 1,
            chatProcessIndex: -1,
            messageChatId: 'message-1',
            continue: true,
            rerollSnapshot: undefined,
        })
    })

    it('rejects an incomplete checkpoint instead of guessing', () => {
        expect(getRevenantWorkflowResumeContext(workflowWithMetadata({
            version: 1,
            chatProcessIndex: -1,
            continue: false,
        }))).toBeUndefined()
    })
})

describe('manual image workflow', () => {
    it('uses a separate workflow room and durable target/message identifiers', async () => {
        let submitted: any
        vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
            submitted = JSON.parse(String(init?.body))
            return new Response(JSON.stringify({
                workflow: {
                    workflowId: 'image-workflow-1',
                    characterId: submitted.characterId,
                    roomId: submitted.roomId,
                    planVersion: 1,
                    context: submitted.context,
                    status: 'active',
                    steps: [],
                    createdAt: 1,
                    updatedAt: 1,
                },
            }), { status: 200, headers: { 'content-type': 'application/json' } })
        }))

        await beginImageGenerationWorkflow({
            characterId: 'character-1',
            roomId: 'room-1',
            prompt: 'portrait',
            negativePrompt: 'blur',
            seed: 42,
            label: 'NovelAI',
            projection: 'append',
        })

        expect(submitted.roomId).toBe('image-generation:room-1')
        expect(submitted.plan).toEqual([expect.objectContaining({ key: 'image.generate' })])
        expect(submitted.context).toMatchObject({
            kind: 'image-generation',
            target: { characterId: 'character-1', roomId: 'room-1' },
            prompt: 'portrait',
            negativePrompt: 'blur',
            seed: 42,
            label: 'NovelAI',
        })
        expect(submitted.context.operationId).toEqual(expect.any(String))
        expect(submitted.context.messageId).toEqual(expect.any(String))

        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
            new Response(JSON.stringify({ workflow: null }), { status: 200 }),
        ))
        await getActiveRevenantWorkflow('character-1', 'image-generation:room-1')
    })
})

describe('active workflow client state', () => {
    it('tracks one active main workflow independently for each room', async () => {
        const first = workflowWithMetadata()
        const second = {
            ...workflowWithMetadata(),
            workflowId: 'workflow-2',
            roomId: 'room-2',
        }
        const fetchMock = vi.fn()
            .mockResolvedValueOnce(new Response(JSON.stringify({ workflow: first }), { status: 200 }))
            .mockResolvedValueOnce(new Response(JSON.stringify({ workflow: second }), { status: 200 }))
            .mockResolvedValueOnce(new Response(JSON.stringify({ workflow: null }), { status: 200 }))
            .mockResolvedValueOnce(new Response(JSON.stringify({ workflow: null }), { status: 200 }))
        vi.stubGlobal('fetch', fetchMock)

        await getActiveRevenantWorkflow('character-1', 'room-1')
        await getActiveRevenantWorkflow('character-1', 'room-2')
        expect(new Set(get(activeRevenantWorkflows).map(workflow => workflow.workflowId))).toEqual(
            new Set([first.workflowId, second.workflowId]),
        )

        await getActiveRevenantWorkflow('character-1', 'room-1')
        await getActiveRevenantWorkflow('character-1', 'room-2')
        expect(get(activeRevenantWorkflows)).toEqual([])
    })

    it('authenticates workflow job mutations without a browser ownership lease', async () => {
        const workflow = workflowWithMetadata()
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
            new Response(JSON.stringify({ workflow }), { status: 200 }),
        ))

        await getActiveRevenantWorkflow('character-1', 'room-1')
        trackRevenantGenerationWorkflow('job-1', workflow.workflowId)

        const headers = await createRevenantJobMutationHeaders('job-1')
        expect(headers['x-revenant-workflow-owner-epoch']).toBeUndefined()
        expect(headers['x-sync-client-id']).toBe('client-1')
    })

    it('loads a terminal workflow so another device can apply cancellation UI state', async () => {
        const workflow = { ...workflowWithMetadata(), status: 'cancelled' as const }
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
            new Response(JSON.stringify({ workflow }), { status: 200 }),
        ))

        await expect(getRevenantWorkflow('workflow-1')).resolves.toEqual(workflow)
        expect(get(activeRevenantWorkflows)).toEqual([])
    })

    it('cancels from any reconnected client', async () => {
        const workflow = workflowWithMetadata()
        const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
            if (String(input).includes('/active?')) {
                return new Response(JSON.stringify({ workflow }), { status: 200 })
            }
            expect(String(input)).toBe('/api/generation/workflows/workflow-1/cancel')
            expect(init?.method).toBe('POST')
            expect(init?.body).toBeUndefined()
            expect(new Headers(init?.headers).get('x-revenant-workflow-owner-epoch')).toBeNull()
            expect(new Headers(init?.headers).get('x-sync-client-id')).toBe('client-1')
            return new Response(JSON.stringify({ success: true }), { status: 200 })
        })
        vi.stubGlobal('fetch', fetchMock)

        await getActiveRevenantWorkflow('character-1', 'room-1')
        await cancelRevenantWorkflow('workflow-1')

        expect(get(activeRevenantWorkflows)).toEqual([])
    })

    it('accepts a lost cancel response when the durable workflow is cancelled', async () => {
        const cancelled = { ...workflowWithMetadata(), status: 'cancelled' as const }
        const fetchMock = vi.fn()
            .mockResolvedValueOnce(new Response('Bad gateway', { status: 502 }))
            .mockResolvedValueOnce(new Response(JSON.stringify({ workflow: cancelled }), { status: 200 }))
        vi.stubGlobal('fetch', fetchMock)

        await expect(cancelRevenantWorkflow('workflow-1')).resolves.toBeUndefined()
        expect(fetchMock).toHaveBeenNthCalledWith(
            2,
            '/api/generation/workflows/workflow-1',
            expect.anything(),
        )
    })

    it('keeps the cancel error when the durable workflow is still active', async () => {
        const fetchMock = vi.fn()
            .mockResolvedValueOnce(new Response('Bad gateway', { status: 502 }))
            .mockResolvedValueOnce(new Response(JSON.stringify({
                workflow: workflowWithMetadata(),
            }), { status: 200 }))
        vi.stubGlobal('fetch', fetchMock)

        await expect(cancelRevenantWorkflow('workflow-1')).rejects.toThrow(
            'Failed to cancel generation workflow: 502',
        )
    })

    it('surfaces an input commit conflict instead of misclassifying it as a busy room', async () => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
            new Response(JSON.stringify({
                error: 'Chat changed before the generation input was committed',
            }), { status: 409 }),
        ))

        await expect(beginRevenantWorkflow({
            characterId: 'character-1',
            roomId: 'room-1',
            plan: [{ key: 'input.commit', kind: 'input.chat.commit', recoveryPolicy: 'resume' }],
            context: {} as any,
        })).rejects.toThrow('Chat changed before the generation input was committed')
    })

    it('preserves the remaining registration grace period for an abandoned setup', async () => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
            new Response(JSON.stringify({
                error: 'A generation workflow is already active for this room',
                busyReason: 'main_job_unregistered',
                retryAfterMs: 17_750,
            }), { status: 409 }),
        ))

        const error = await beginRevenantWorkflow({
            characterId: 'character-1',
            roomId: 'room-1',
            plan: [{ key: 'input.commit', kind: 'input.chat.commit', recoveryPolicy: 'resume' }],
            context: {} as any,
        }).catch(caught => caught)

        expect(error).toBeInstanceOf(RevenantWorkflowBusyError)
        expect(error.retryAfterMs).toBe(17_750)
    })

})
