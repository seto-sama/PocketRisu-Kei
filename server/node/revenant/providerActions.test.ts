import { describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import providerPkg from './providerActions.cjs'
import workerPkg from './postprocessWorker.cjs'
import serviceAccountPkg from '../googleServiceAccount.cjs'
import { makeServiceAccountFixture } from '../../../src/ts/preset/adapter/googleServiceAccount/__testFixtures'

const { createServerProviderActionExecutor, canExecuteServerProviderAction } = providerPkg
const { createRevenantPostprocessWorker } = workerPkg

function preset(adapterKind = 'openai-compatible') {
    return {
        id: 'aux-preset', name: 'Auxiliary', apiKeyRef: 'pool-key',
        userValues: {}, createdAt: 1, updatedAt: 1,
        profileSnapshot: {
            profileId: 'test:model', providerBaseId: 'test', adapterKind,
            modelId: 'test-model',
            auth: { kind: 'bearer' },
            endpoint: { kind: 'static', url: 'https://test.invalid/v1/chat/completions' },
            schema: [], defaults: {}, uiSchema: { groups: [], fields: [] },
            capabilities: ['streaming'],
        },
    }
}

function harness(model = preset(), executorOptions = {}) {
    const chat = { id: 'room-1', message: [{ role: 'char', data: 'main answer' }] }
    const recipe: any = {
        providerBackend: 'http', modelPreset: model,
        auxProviders: { otherAx: { backend: 'http', modelPreset: model } },
        character: { name: 'Alice', lowLevelAccess: true, triggerscript: [] },
        database: { globalChatVariables: {}, templateDefaultVariables: '', username: 'Bob', personas: [] },
        chat, modules: [], moduleTriggers: [], moduleRegexScripts: [],
    }
    const steps: Record<string, any> = Object.fromEntries(
        ['output.transform', 'trigger.output', 'igp', 'postprocess', 'message.materialize']
            .map(key => [key, { key, status: 'pending' }]),
    )
    const workflow = {
        workflowId: 'workflow-1', characterId: 'char-1', roomId: 'room-1', status: 'active',
        context: { kind: 'chat-generation', postprocess: recipe },
        get steps() { return Object.values(steps) },
    }
    const jobs: any[] = []
    const transitions: string[] = []
    const repository = {
        getGenerationWorkflow: () => workflow,
        createGenerationJob: vi.fn((input: any) => {
            jobs.push({ ...input, status: 'queued' })
        }),
        getGenerationJob: (id: string) => jobs.find(job => job.jobId === id),
        markGenerationMaterialized: vi.fn(),
        listReadyChatWorkflowJobs: () => workflow.status === 'active'
            ? [{ jobId: 'main-job', workflowId: workflow.workflowId, projection: { content: 'main answer' } }]
            : [],
        claimGenerationWorkflowStep: (_id: string, key: string) => {
            if (steps[key].status !== 'pending') return null
            steps[key].status = 'running'
            return workflow
        },
        updateGenerationWorkflowStep: (_id: string, key: string, update: any) => {
            transitions.push(update.status)
            Object.assign(steps[key], update)
        },
        finishGenerationWorkflow: (_id: string, status: string) => { workflow.status = status },
    }
    const scheduleGenerationDispatch = vi.fn(() => {
        const job = jobs.at(-1)
        job.status = 'generated'
        job.responseStatus = 200
        job.responseHeaders = { 'content-type': 'application/json' }
        job.rawResponse = Buffer.from(JSON.stringify({ choices: [{ message: { content: `answer-${jobs.length}` } }] }))
    })
    const cancelJob = vi.fn((id: string) => { repository.getGenerationJob(id).status = 'cancelled' })
    const executeProviderAction = createServerProviderActionExecutor({
        repository, scheduleGenerationDispatch, sanitizeGenerationTargetUrl: (url: string) => url,
        getDatabase: () => ({ apiKeyPool: { 'pool-key': { key: 'test-secret' } } }),
        readInlay: async () => ({}), writeMedia: async () => '{{inlayeddata::image}}', cancelJob,
        ...executorOptions,
    })
    const action: any = {
        actionId: 'trigger.0.provider', kind: 'provider.axllm',
        payload: { backend: 'http', modelPreset: model, prompt: [{ role: 'user', content: 'judge' }] },
    }
    return { repository, scheduleGenerationDispatch, cancelJob, executeProviderAction,
        workflow, recipe, steps, jobs, action, transitions }
}

describe('server postprocess provider actions', () => {
    it('persists, dispatches, and consumes a server-created auxiliary job in the real repository', () => {
        const directory = mkdtempSync(resolve(tmpdir(), 'pocketrisu-server-provider-'))
        const h = harness()
        const script = String.raw`
            const path = require('path');
            const fs = require('fs');
            const base = process.argv[1];
            const db = require(path.join(base, 'generationDb.cjs'));
            const { generationJournalStore } = require(path.join(base, 'generationJournal.cjs'));
            const { createServerProviderActionExecutor } = require(path.join(base, 'providerActions.cjs'));
            const { recipe, action } = JSON.parse(process.argv[2]);
            db.createGenerationWorkflow({
                workflowId: 'workflow-1', characterId: 'char-1', roomId: 'room-1',
                context: { kind: 'chat-generation', postprocess: recipe },
                plan: [{ key: 'trigger.output', kind: 'postprocess.trigger.output',
                    recoveryPolicy: 'resume', status: 'pending', order: 0 }],
            });
            db.claimGenerationWorkflowStep('workflow-1', 'trigger.output');
            const execute = createServerProviderActionExecutor({
                repository: db,
                getDatabase: () => ({ apiKeyPool: { 'pool-key': { key: 'test-secret' } } }),
                sanitizeGenerationTargetUrl: url => url,
                scheduleGenerationDispatch: () => {
                    const queued = db.listQueuedGenerationDispatches(10);
                    if (queued.length !== 1) throw new Error('Expected one durable queue entry');
                    const id = queued[0].job.jobId;
                    if (!db.claimQueuedGenerationDispatch(id)) throw new Error('Dispatch claim failed');
                    db.setGenerationJobGenerating(id);
                    db.setGenerationJobHeaders(id, 200, { 'content-type': 'application/json' });
                    fs.appendFileSync(generationJournalStore.journalPath('workflow-1', id),
                        JSON.stringify({ choices: [{ message: { content: 'persisted answer' } }] }));
                    db.finishGenerationJob(id, 'generated', 'provider_complete');
                },
            });
            execute({ workflow: db.getGenerationWorkflow('workflow-1'), action }).then(result => {
                process.stdout.write(JSON.stringify({ result,
                    jobs: db.listGenerationWorkflowJobs('workflow-1'),
                    workflow: db.getGenerationWorkflow('workflow-1'),
                }));
            });
        `
        try {
            const output = JSON.parse(execFileSync(process.execPath, ['-e', script,
                resolve('server/node/revenant'), JSON.stringify({ recipe: h.recipe, action: h.action }),
            ], { cwd: directory, encoding: 'utf8' }))
            expect(output.result).toEqual({ success: true, result: 'persisted answer' })
            expect(output.jobs).toHaveLength(1)
            expect(output.jobs[0]).toMatchObject({ status: 'generated', jobType: 'otherAx' })
            expect(output.jobs[0].materializedAt).toBeTypeOf('number')
            expect(output.workflow.steps[0].status).toBe('running')
            expect(output.workflow.steps[1]).toMatchObject({
                key: 'client-action:trigger.0.provider', status: 'completed',
            })
        } finally {
            rmSync(directory, { recursive: true, force: true })
        }
    })

    it('runs consecutive Lua calls and IGP after main completion without any client action', async () => {
        const h = harness()
        h.recipe.auxProviders.emotion = { backend: 'http', modelPreset: preset() }
        h.recipe.database.igpPrompt = 'finish'
        h.recipe.character.triggerscript = [{
            type: 'output', conditions: [], effect: [{ type: 'triggerlua', code: `
                onOutput = async(function(id)
                    local first = axLLM(id, {{ role = 'user', content = 'first' }})
                    local second = axLLM(id, {{ role = 'user', content = first.result }})
                    setChatVar(id, 'auxResult', second.result)
                end)
            ` }],
        }] as any
        const materialize = vi.fn(async () => {})
        const worker = createRevenantPostprocessWorker({
            repository: h.repository, executeProviderAction: h.executeProviderAction,
            materializeGeneration: materialize,
            runOutputStage: async () => ({ status: 'completed', text: 'main answer', chat: h.recipe.chat }),
        })
        await worker.pump()
        // Repeated wakes while an action is running must not duplicate its request.
        await worker.pump()
        await vi.waitFor(() => expect(h.workflow.status).toBe('completed'))
        expect(h.jobs).toHaveLength(3)
        const bodies = h.jobs.map(job => JSON.parse(Buffer.from(job.requestSpec.bodyBase64, 'base64').toString()))
        expect(bodies.map(body => body.messages[0].content)).toEqual(['first', 'answer-1', 'finish'])
        expect(h.steps['trigger.output'].metadata.chat.scriptstate.$auxResult).toBe('answer-2')
        expect(h.transitions).not.toContain('waiting_client')
        expect(h.jobs.every(job => job.workflowStepKey !== 'model.main' && job.jobType !== 'model')).toBe(true)
        expect(h.repository.markGenerationMaterialized).toHaveBeenCalledTimes(3)
        expect(materialize).toHaveBeenCalledTimes(1)
    })

    it('uses pooled credentials and keeps the request attached to its workflow', async () => {
        const h = harness()
        expect(await h.executeProviderAction({ workflow: h.workflow, action: h.action }))
            .toEqual({ success: true, result: 'answer-1' })
        expect(h.jobs[0]).toMatchObject({
            workflowId: 'workflow-1', workflowStepKey: 'client-action:trigger.0.provider',
            jobType: 'otherAx', adapterKind: 'openai-compatible',
            dispatchMaxConcurrent: 1,
            requestSpec: { headers: { authorization: 'Bearer test-secret' } },
        })
    })

    it('registers server-planned Hypa calls with their memory identity and batch limits', async () => {
        const h = harness()
        const operationContext = { kind: 'hypav3-summary', operationId: 'operation-1',
            batchId: 'batch-1', characterId: 'char-1', roomId: 'room-1', chatMemos: ['memo-1'], purpose: 'memory' }
        await h.executeProviderAction({ workflow: h.workflow, action: h.action,
            operationContext, dispatchPolicy: { maxConcurrent: 2, requestsPerMinute: 10 } })
        expect(h.jobs[0]).toMatchObject({
            jobType: 'memory', operationContext,
            dispatchGroup: 'workflow-1:hypa:batch-1', dispatchMaxConcurrent: 2, dispatchRequestsPerMinute: 10,
        })
    })

    it.each(['google-gemini', 'openai-compatible'])('runs %s service-account generation without a browser token request', async kind => {
        const sa = { ...JSON.parse(makeServiceAccountFixture().sourceJson), project_id: 'demo-project' }
        const model = preset(kind)
        model.profileSnapshot.auth.kind = 'google-service-account'
        model.profileSnapshot.endpoint = { kind: kind === 'google-gemini' ? 'vertex-gemini' : 'vertex-openai' } as any
        model.profileSnapshot.schema = [{
            key: 'location', type: 'string', mapsTo: { target: 'custom', path: 'location' },
        }] as any
        model.userValues = { location: 'us-central1' }
        const fetchImpl = vi.fn(async () => Response.json({ access_token: 'google-token', expires_in: 3600 }))
        const h = harness(model, {
            tokenCache: serviceAccountPkg.createServerServiceAccountTokenCache({ fetchImpl }),
            getDatabase: () => ({ apiKeyPool: { 'pool-key': { key: JSON.stringify(sa) } } }),
        })
        if (kind === 'google-gemini') {
            h.scheduleGenerationDispatch.mockImplementation(() => Object.assign(h.jobs.at(-1), {
                status: 'generated', responseStatus: 200,
                rawResponse: Buffer.from(JSON.stringify({ candidates: [{ content: { parts: [{ text: 'answer' }] } }] })),
            }))
        }
        expect(canExecuteServerProviderAction(h.action)).toBe(true)
        expect((await h.executeProviderAction({ workflow: h.workflow, action: h.action })).success).toBe(true)
        expect((await h.executeProviderAction({ workflow: h.workflow, action: h.action })).success).toBe(true)
        expect(fetchImpl).toHaveBeenCalledTimes(1)
        expect(fetchImpl.mock.calls[0][0]).toBe('https://oauth2.googleapis.com/token')
        expect(h.jobs).toHaveLength(2)
        for (const job of h.jobs) {
            expect(job.requestSpec.headers.authorization).toBe('Bearer google-token')
            expect(job.requestSpec.targetUrl).toContain('/projects/demo-project/locations/us-central1/')
            expect(JSON.stringify(job.requestSpec)).not.toContain('PRIVATE KEY')
        }
    })

    it('collects a streaming provider response, including reasoning', async () => {
        const h = harness()
        h.action.payload.options = { streaming: true }
        h.scheduleGenerationDispatch.mockImplementation(() => {
            Object.assign(h.jobs.at(-1), {
                status: 'generated', responseStatus: 200,
                rawResponse: Buffer.from([
                    'data: {"choices":[{"delta":{"reasoning_content":"think"}}]}',
                    'data: {"choices":[{"delta":{"content":"answer"}}]}',
                    'data: [DONE]', '',
                ].join('\n\n')),
            })
        })
        expect(await h.executeProviderAction({ workflow: h.workflow, action: h.action }))
            .toEqual({ success: true, result: '<Thoughts>\nthink\n</Thoughts>\n\nanswer' })
        expect(h.jobs[0].streaming).toBe(true)
    })

    it.each([
        ['anthropic-messages', { content: [{ type: 'text', text: 'native answer' }] }],
        ['google-gemini', { candidates: [{ content: { parts: [{ text: 'native answer' }] } }] }],
        ['openai-responses', { output: [{ type: 'message', content: [{ type: 'output_text', text: 'native answer' }] }] }],
        ['amazon-bedrock', { output: { message: { content: [{ text: 'native answer' }] } } }],
    ])('reuses the %s request and response adapter', async (kind, response) => {
        const model = preset(kind as string)
        const h = harness(model)
        h.scheduleGenerationDispatch.mockImplementation(() => {
            Object.assign(h.jobs.at(-1), {
                status: 'generated', responseStatus: 200, rawResponse: Buffer.from(JSON.stringify(response)),
            })
        })
        expect(await h.executeProviderAction({ workflow: h.workflow, action: h.action }))
            .toEqual({ success: true, result: 'native answer' })
        expect(h.jobs[0].adapterKind).toBe(kind)
    })

    it('returns provider errors to Lua instead of restarting the request', async () => {
        const h = harness()
        h.scheduleGenerationDispatch.mockImplementation(() => {
            Object.assign(h.jobs.at(-1), { status: 'failed', error: 'Connection closed' })
        })
        expect(await h.executeProviderAction({ workflow: h.workflow, action: h.action }))
            .toEqual({ success: false, result: 'Error: Connection closed' })
        expect(h.jobs).toHaveLength(1)
    })

    it('cancels a queued action when its workflow is cancelled', async () => {
        const h = harness()
        h.scheduleGenerationDispatch.mockImplementation(() => { h.workflow.status = 'cancelled' })
        const result = await h.executeProviderAction({ workflow: h.workflow, action: h.action })
        expect(result.success).toBe(false)
        expect(h.cancelJob).toHaveBeenCalledWith(h.jobs[0].jobId)
        expect(h.jobs[0].status).toBe('cancelled')
        const count = h.jobs.length
        await h.executeProviderAction({ workflow: h.workflow, action: h.action })
        expect(h.jobs).toHaveLength(count)
    })

    it('leaves plugins, batch transport, and foreground actions on the client', () => {
        const h = harness()
        expect(canExecuteServerProviderAction(h.action)).toBe(true)
        h.action.payload.modelPreset = preset('plugin')
        expect(canExecuteServerProviderAction(h.action)).toBe(false)
        h.action.payload.modelPreset = { ...preset(), claudeBatching: true } as any
        expect(canExecuteServerProviderAction(h.action)).toBe(false)
        const serviceAccount = preset()
        serviceAccount.profileSnapshot.auth.kind = 'google-service-account'
        h.action.payload.modelPreset = serviceAccount
        expect(canExecuteServerProviderAction(h.action)).toBe(true)
        expect(canExecuteServerProviderAction({ kind: 'ui.input' })).toBe(false)
    })
})
