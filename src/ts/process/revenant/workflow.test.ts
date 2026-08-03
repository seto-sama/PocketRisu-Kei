import { afterEach, describe, expect, it, vi } from 'vitest'
import { get } from 'svelte/store'
import type { RevenantWorkflow } from './types'
import {
    activeRevenantWorkflows,
    cancelRevenantWorkflow,
    createChatGenerationWorkflowPlan,
    createRevenantWorkflowResumeMetadata,
    getActiveRevenantWorkflow,
    getRevenantWorkflow,
    getRevenantWorkflowResumeContext,
} from './workflow'
import {
    configureRevenantGenerationClient,
    createRevenantJobMutationHeaders,
    trackRevenantGenerationWorkflow,
} from './client'

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
            persistUserMessage: true,
            hypaEnabled: false,
            igpEnabled: true,
            pluginProvider: false,
        })

        expect(plan.map(step => step.key)).toEqual([
            'user.persist',
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
        expect(plan.at(-1)?.key).toBe('message.materialize')
    })

    it('waits for a browser dispatch only for plugin providers', () => {
        const plan = createChatGenerationWorkflowPlan({
            resumeContext: {
                version: 1,
                chatProcessIndex: -1,
                messageChatId: 'message-1',
                continue: false,
            },
            persistUserMessage: false,
            hypaEnabled: false,
            igpEnabled: false,
            pluginProvider: true,
        })

        expect(plan.find(step => step.key === 'model.dispatch')?.status).toBe('pending')
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

describe('active workflow client state', () => {
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

    it('publishes a reconnected workflow and clears it when the server no longer has one', async () => {
        const workflow = workflowWithMetadata()
        const fetchMock = vi.fn()
            .mockResolvedValueOnce(new Response(JSON.stringify({ workflow }), { status: 200 }))
            .mockResolvedValueOnce(new Response(JSON.stringify({ workflow: null }), { status: 200 }))
        vi.stubGlobal('fetch', fetchMock)

        await getActiveRevenantWorkflow('character-1', 'room-1')
        expect(get(activeRevenantWorkflows)).toEqual([workflow])

        await getActiveRevenantWorkflow('character-1', 'room-1')
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

})
