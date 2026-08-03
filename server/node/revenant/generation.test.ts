import { describe, expect, it } from 'vitest'
import streamPkg from './generationStream.cjs'
import generationPkg from './generation.cjs'

const { notifyRevenantJournalWaiters, streamRevenantJournal, sendRevenantJournalEvent } = streamPkg as {
    notifyRevenantJournalWaiters: (job: any) => void
    streamRevenantJournal: (
        ws: FakeSocket,
        job: any,
        offset: number,
        store: {
            readChunk: (
                workflowId: string | null,
                jobId: string,
                offset: number,
            ) => Promise<{ offset: number, bytes: Buffer }>
        },
    ) => Promise<void>
    sendRevenantJournalEvent: (ws: FakeSocket, job: any, event: object) => void
}
const {
    isRevenantWorkflowClientActionJobAllowed,
    normalizeRevenantDispatchPolicy,
    normalizeRevenantHypaExecutionRecipe,
    normalizeRevenantOperationContext,
    normalizeRevenantWorkflowContext,
    normalizeRevenantWorkflowPlan,
    normalizeRevenantWorkflowStepUpdate,
    normalizeRevenantWorkflowDependency,
    resolveRevenantWorkflowRequestBody,
} = generationPkg as {
    isRevenantWorkflowClientActionJobAllowed: (input: Record<string, unknown>) => boolean
    normalizeRevenantDispatchPolicy: (
        value: unknown,
        operation: unknown,
        workflowId?: string,
    ) => unknown
    normalizeRevenantHypaExecutionRecipe: (value: unknown) => unknown
    normalizeRevenantOperationContext: (jobType: string, value: unknown) => any
    normalizeRevenantWorkflowContext: (
        value: unknown,
        characterId: string,
        roomId: string,
    ) => any
    normalizeRevenantWorkflowPlan: (value: unknown) => unknown
    normalizeRevenantWorkflowStepUpdate: (value: unknown) => unknown
    normalizeRevenantWorkflowDependency: (
        value: unknown,
        jobType: string,
        workflowId?: string,
    ) => unknown
    resolveRevenantWorkflowRequestBody: (
        bodyBase64: string,
        dependency: unknown,
        execution: unknown,
    ) => string
}

describe('revenant delegated provider job validation', () => {
    it('allows a claimed API v3 main dispatch only on model.main', () => {
        const input = {
            parentStepKey: 'model.dispatch',
            actionId: 'model.dispatch.plugin',
            jobType: 'model',
            workflowStepKey: 'model.main',
            action: { actionId: 'model.dispatch.plugin', kind: 'provider.main' },
        }
        expect(isRevenantWorkflowClientActionJobAllowed(input)).toBe(true)
        expect(isRevenantWorkflowClientActionJobAllowed({
            ...input,
            workflowStepKey: 'client-action:model.dispatch.plugin',
        })).toBe(false)
        expect(isRevenantWorkflowClientActionJobAllowed({
            ...input,
            parentStepKey: 'trigger.output',
        })).toBe(false)
    })

    it('keeps ordinary client action jobs out of model.main', () => {
        const actionId = 'trigger.0.provider.llm'
        const input = {
            parentStepKey: 'trigger.output',
            actionId,
            jobType: 'otherAx',
            workflowStepKey: `client-action:${actionId}`,
            action: { actionId, kind: 'provider.llm' },
        }
        expect(isRevenantWorkflowClientActionJobAllowed(input)).toBe(true)
        expect(isRevenantWorkflowClientActionJobAllowed({
            ...input,
            jobType: 'model',
            workflowStepKey: 'model.main',
        })).toBe(false)
    })
})

describe('revenant durable dispatch validation', () => {
    const operation = {
        kind: 'hypav3-summary',
        operationId: 'operation-1',
        batchId: 'batch-1',
        characterId: 'character-1',
        roomId: 'room-1',
        chatMemos: ['message-1'],
    }

    it('derives a server-owned dispatch group from a validated Hypa batch', () => {
        const normalizedOperation = normalizeRevenantOperationContext('memory', operation)
        expect(normalizeRevenantDispatchPolicy({
            maxConcurrent: 3,
            requestsPerMinute: 20,
        }, normalizedOperation, 'workflow-1')).toEqual({
            dispatchGroup: 'workflow-1:hypa:batch-1',
            maxConcurrent: 3,
            requestsPerMinute: 20,
        })
    })

    it('rejects unsafe batches and impossible limits', () => {
        expect(normalizeRevenantOperationContext('memory', {
            ...operation,
            batchId: '../unsafe',
        })).toBeUndefined()
        expect(normalizeRevenantDispatchPolicy({
            maxConcurrent: 4,
            requestsPerMinute: 3,
        }, operation, 'workflow-1')).toBeUndefined()
        expect(normalizeRevenantDispatchPolicy({
            maxConcurrent: 3,
            requestsPerMinute: 20,
        }, { kind: 'translation' }, 'workflow-1')).toBeUndefined()
    })
})

describe('revenant workflow-dependent main dispatch', () => {
    const placeholder = '__RISU_REVENANT_HYPA_123e4567-e89b__'
    const dependency = { kind: 'hypav3-selection', placeholder }

    it('accepts only workflow-linked model dependencies', () => {
        expect(normalizeRevenantWorkflowDependency(
            dependency,
            'model',
            'workflow-1',
        )).toEqual(dependency)
        expect(normalizeRevenantWorkflowDependency(
            dependency,
            'memory',
            'workflow-1',
        )).toBeUndefined()
        expect(normalizeRevenantWorkflowDependency(
            dependency,
            'model',
        )).toBeUndefined()
        expect(normalizeRevenantWorkflowDependency({
            ...dependency,
            placeholder: '../unsafe',
        }, 'model', 'workflow-1')).toBeUndefined()
    })

    it('replaces the deferred Hypa prompt in a JSON provider request', () => {
        const body = Buffer.from(JSON.stringify({
            messages: [
                { role: 'system', content: `prefix ${placeholder} suffix` },
                { role: 'user', content: 'hello' },
            ],
        })).toString('base64')
        const resolved = resolveRevenantWorkflowRequestBody(body, dependency, {
            kind: 'hypav3-selection',
            status: 'completed',
            result: {
                chatSequence: [{
                    chat: {
                        role: 'system',
                        content: 'selected memory',
                        memo: 'supaMemory',
                    },
                }],
            },
        })
        expect(JSON.parse(Buffer.from(resolved, 'base64').toString('utf8'))).toEqual({
            messages: [
                { role: 'system', content: 'prefix selected memory suffix' },
                { role: 'user', content: 'hello' },
            ],
        })
    })

    it('rejects dispatch before completion or without the exact placeholder', () => {
        const body = Buffer.from(JSON.stringify({ messages: [] })).toString('base64')
        expect(() => resolveRevenantWorkflowRequestBody(body, dependency, {
            kind: 'hypav3-selection',
            status: 'running',
        })).toThrow('not complete')
        expect(() => resolveRevenantWorkflowRequestBody(body, dependency, {
            kind: 'hypav3-selection',
            status: 'completed',
            result: {
                chatSequence: [{
                    chat: { content: 'memory', memo: 'supaMemory' },
                }],
            },
        })).toThrow('no HypaV3 placeholder')
    })
})

class FakeSocket {
    journalRecoverySubscriber = false
    messages: any[] = []
    send(value: string): void {
        this.messages.push(JSON.parse(value))
    }
}

describe('revenant journal stream', () => {
    const job = {
        id: 'job-1',
        workflowId: 'workflow-1',
        responseStatus: 200,
        responseHeaders: { 'content-type': 'text/event-stream' },
        rawBytes: 6,
        done: true,
        terminalEvent: { type: 'done' },
    }

    it('sends headers, the requested byte suffix, and terminal state', async () => {
        const socket = new FakeSocket()
        const journal = Buffer.from('abcdef')
        await streamRevenantJournal(socket, job, 3, {
            async readChunk(_workflowId, _jobId, offset) {
                return { offset, bytes: journal.subarray(offset) }
            },
        })
        expect(socket.messages.map(message => message.type)).toEqual([
            'upstream_headers',
            'chunk',
            'done',
        ])
        expect(Buffer.from(socket.messages[1].dataBase64, 'base64').toString()).toBe('def')
    })

    it('turns an errored partial journal into a clean recovery tail', () => {
        const socket = new FakeSocket()
        socket.journalRecoverySubscriber = true
        sendRevenantJournalEvent(socket, job, { type: 'error', message: 'lost' })
        expect(socket.messages[0]).toMatchObject({ type: 'done', partial: true })
    })

    it('reports provider dispatch before response headers', async () => {
        const socket = new FakeSocket()
        await streamRevenantJournal(socket, {
            ...job,
            providerStartedAt: 123,
        }, 0, {
            async readChunk() {
                return { offset: 0, bytes: Buffer.alloc(0) }
            },
        })
        expect(socket.messages.slice(0, 2)).toEqual([
            { type: 'provider_started', startedAt: 123 },
            {
                type: 'upstream_headers',
                status: 200,
                headers: { 'content-type': 'text/event-stream' },
            },
        ])
    })

    it('tails bytes appended after the socket reaches EOF', async () => {
        const socket = new FakeSocket()
        const liveJob = {
            ...job,
            rawBytes: 0,
            done: false,
            journalWaiters: [],
        }
        let journal = Buffer.alloc(0)
        const streaming = streamRevenantJournal(socket, liveJob, 0, {
            async readChunk(_workflowId, _jobId, offset) {
                return { offset, bytes: journal.subarray(offset) }
            },
        })

        while (liveJob.journalWaiters.length === 0) await Promise.resolve()
        journal = Buffer.from('later')
        liveJob.rawBytes = journal.length
        notifyRevenantJournalWaiters(liveJob)
        while (!socket.messages.some(message => message.type === 'chunk')) await Promise.resolve()
        liveJob.done = true
        notifyRevenantJournalWaiters(liveJob)
        await streaming

        const chunk = socket.messages.find(message => message.type === 'chunk')
        expect(Buffer.from(chunk.dataBase64, 'base64').toString()).toBe('later')
        expect(socket.messages.at(-1)?.type).toBe('done')
    })
})

describe('revenant workflow validation', () => {
    const workflowContext = {
        schemaVersion: 1,
        kind: 'chat-generation',
        resume: {
            schemaVersion: 1,
            chatProcessIndex: -1,
            messageChatId: 'message-1',
            isContinuation: false,
        },
        postprocess: {
            schemaVersion: 1,
            messageChatId: 'message-1',
            isContinuation: false,
            providerBackend: 'http',
            modelPreset: {},
            auxProviders: {
                emotion: { backend: 'plugin', modelPreset: { id: 'igp-preset' } },
            },
            character: { chaId: 'character-1' },
            chat: { id: 'room-1', message: [] },
            database: {},
            modules: [],
            moduleRegexScripts: [],
            moduleTriggers: [],
        },
    }

    it('accepts a bounded chat workflow execution context', () => {
        expect(normalizeRevenantWorkflowContext(
            workflowContext,
            'character-1',
            'room-1',
        )).toEqual(workflowContext)
        expect(normalizeRevenantWorkflowContext(
            { ...workflowContext, postprocess: { ...workflowContext.postprocess, providerBackend: 'echo' } },
            'character-1',
            'room-1',
        )).toBeUndefined()
        expect(normalizeRevenantWorkflowContext(
            {
                ...workflowContext,
                postprocess: {
                    ...workflowContext.postprocess,
                    auxProviders: {
                        emotion: { backend: 'legacy', modelPreset: {} },
                    },
                },
            },
            'character-1',
            'room-1',
        )).toBeUndefined()
        expect(normalizeRevenantWorkflowContext(
            workflowContext,
            'different-character',
            'room-1',
        )).toBeUndefined()
    })

    it('normalizes an ordered checkpoint plan', () => {
        expect(normalizeRevenantWorkflowPlan([
            {
                key: 'user.persist',
                kind: 'user.persist',
                recoveryPolicy: 'resume',
                status: 'completed',
            },
            {
                key: 'lua.llm:run-1:0',
                kind: 'lua.llm',
                recoveryPolicy: 'replay_output',
                metadata: { callIndex: 0 },
            },
        ])).toEqual([
            {
                key: 'user.persist',
                kind: 'user.persist',
                recoveryPolicy: 'resume',
                status: 'completed',
                order: 0,
            },
            {
                key: 'lua.llm:run-1:0',
                kind: 'lua.llm',
                recoveryPolicy: 'replay_output',
                status: 'pending',
                metadata: { callIndex: 0 },
                order: 1,
            },
        ])
    })

    it('rejects duplicate or unsafe step keys and non-initial states', () => {
        expect(normalizeRevenantWorkflowPlan([
            { key: 'same', kind: 'one', recoveryPolicy: 'resume' },
            { key: 'same', kind: 'two', recoveryPolicy: 'resume' },
        ])).toBeUndefined()
        expect(normalizeRevenantWorkflowPlan([
            { key: '../unsafe key', kind: 'one', recoveryPolicy: 'resume' },
        ])).toBeUndefined()
        expect(normalizeRevenantWorkflowPlan([
            { key: 'model.main', kind: 'model.main', recoveryPolicy: 'resume', status: 'running' },
        ])).toBeUndefined()
    })

    it('accepts only known runtime step states', () => {
        expect(normalizeRevenantWorkflowStepUpdate({ status: 'output_ready' }))
            .toEqual({ status: 'output_ready', metadata: null })
        expect(normalizeRevenantWorkflowStepUpdate({
            status: 'waiting_client',
            metadata: {
                checkpoint: 'embedding.local',
                embeddingModel: 'MiniLM',
            },
        })).toEqual({
            status: 'waiting_client',
            metadata: {
                checkpoint: 'embedding.local',
                embeddingModel: 'MiniLM',
            },
        })
        expect(normalizeRevenantWorkflowStepUpdate({ status: 'cancelled' }))
            .toBeUndefined()
    })

    it('accepts remote Hypa recipes and rejects browser-local embedding models', () => {
        const recipe = {
            schemaVersion: 1,
            batchId: 'batch-1',
            expectedOperationIds: ['operation-1'],
            embedding: { model: 'openai3small', apiKey: 'secret' },
            tokenizer: { tokenizer: 'tik', chatAdditionalTokens: 3, useName: 'name' },
            settings: {
                recentMemoryRatio: 0.4,
                similarMemoryRatio: 0.4,
                queryChatCount: 3,
                summaryChunkSeparator: '\\n\\n',
            },
            memory: { summaries: [] },
            chats: [{ role: 'user', content: 'hello' }],
            startIdx: 0,
            currentTokens: 100,
            maxContextTokens: 1000,
            availableMemoryTokens: 200,
            memoryTokens: 250,
            shouldReserveMemoryTokens: true,
            randomSeed: 'seed',
        }
        expect(normalizeRevenantHypaExecutionRecipe(recipe)).toEqual(recipe)
        expect(normalizeRevenantHypaExecutionRecipe({
            ...recipe,
            embedding: { model: 'MiniLM', apiKey: '' },
        })).toBeUndefined()
    })
})
