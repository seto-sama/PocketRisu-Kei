import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

describe('generation workflow step executions', () => {
    it('groups multiple provider jobs under one attempt and preserves later attempts', () => {
        const workingDirectory = mkdtempSync(resolve(tmpdir(), 'pocketrisu-step-execution-'))
        const databaseModule = resolve('server/revenant/generationDb.cjs')
        const script = String.raw`
            const db = require(process.argv[1]);
            db.createGenerationWorkflow({
                workflowId: 'workflow-1',
                characterId: 'character-1',
                roomId: 'room-1',
                context: { schemaVersion: 1, kind: 'chat-generation' },
                plan: [{
                    key: 'model.main',
                    kind: 'model.main',
                    recoveryPolicy: 'replay_output',
                    status: 'pending',
                    order: 0,
                }],
            });
            const create = (jobId, stepExecutionId) => db.createGenerationJob({
                jobId,
                chatId: 'message-1',
                jobType: 'model',
                characterId: 'character-1',
                roomId: 'room-1',
                workflowId: 'workflow-1',
                workflowStepKey: 'model.main',
                stepExecutionId,
            });
            create('job-1', 'execution-1');
            db.finishGenerationJob('job-1', 'generated', 'provider_complete');
            create('job-2', 'execution-1');
            db.finishGenerationJob('job-2', 'generated', 'provider_complete');
            create('job-3', 'execution-2');
            const beforeCancel = db.getGenerationWorkflow('workflow-1');
            const cancellation = db.cancelGenerationStepExecution(
                'workflow-1', 'execution-2',
            );
            const workflow = db.getGenerationWorkflow('workflow-1');
            const jobs = db.listGenerationWorkflowJobs('workflow-1');
            process.stdout.write(JSON.stringify({
                workflow, jobs, beforeCancel, cancellation,
            }));
        `
        try {
            const output = execFileSync(process.execPath, ['-e', script, databaseModule], {
                cwd: workingDirectory,
                encoding: 'utf8',
            })
            const result = JSON.parse(output)
            expect(result.jobs.map((job: any) => job.workflowStepExecutionId)).toEqual([
                'execution-1',
                'execution-1',
                'execution-2',
            ])
            expect(result.beforeCancel.steps[0].executions).toMatchObject([
                { executionId: 'execution-1', attempt: 1, status: 'output_ready' },
                { executionId: 'execution-2', attempt: 2, status: 'waiting_job' },
            ])
            expect(result.beforeCancel.context).toEqual({
                schemaVersion: 1,
                kind: 'chat-generation',
            })
            expect(result.workflow.steps[0]).toMatchObject({ status: 'failed' })
            expect(result.workflow.steps[0].executions[1]).toMatchObject({
                executionId: 'execution-2',
                status: 'failed',
            })
            expect(result.cancellation).toMatchObject({
                changed: true,
                jobs: [{ jobId: 'job-3', status: 'queued' }],
            })
            expect(result.jobs[2]).toMatchObject({
                status: 'cancelled',
                finishReason: 'step_cancelled',
            })
        } finally {
            rmSync(workingDirectory, { recursive: true, force: true })
        }
    })

    it.each(['plugin', 'http'])('carries a pending provider result across %s rounds in one step execution', providerBackend => {
        const workingDirectory = mkdtempSync(resolve(tmpdir(), 'pocketrisu-provider-projection-'))
        const databaseModule = resolve('server/revenant/generationDb.cjs')
        const script = String.raw`
            const db = require(process.argv[1]);
            const providerBackend = process.argv[2];
            const createWorkflow = workflowId => {
                const characterId = workflowId + '-character';
                const roomId = workflowId + '-room';
                db.createGenerationWorkflow({
                    workflowId, characterId, roomId,
                    context: {
                        schemaVersion: 1,
                        kind: 'chat-generation',
                        postprocess: { providerBackend },
                    },
                    plan: [{
                        key: 'model.main',
                        kind: 'model.main',
                        recoveryPolicy: 'replay_output',
                        status: 'pending',
                        order: 0,
                    }],
                });
            };
            const createRound = (workflowId, jobId, stepExecutionId, { bytes, projection } = {}) => {
                db.createGenerationJob({
                    jobId,
                    chatId: workflowId + '-message',
                    jobType: 'model',
                    characterId: workflowId + '-character',
                    roomId: workflowId + '-room',
                    workflowId,
                    workflowStepKey: 'model.main',
                    stepExecutionId,
                });
                const initialProjection = db.getGenerationJob(jobId).projection;
                if (bytes !== undefined) {
                    db.setGenerationJobHeaders(jobId, 200, {});
                    db.finishGenerationJob(jobId, 'generated', 'provider_complete', null, bytes);
                    if (projection) {
                        db.setGenerationJobProjection(jobId, { ...projection, journalBytes: bytes });
                    }
                }
                return initialProjection;
            };
            const pendingProjection = {
                schemaVersion: 1,
                source: 'server',
                adapterKind: 'openai-compatible',
                content: '',
                journalBytes: 50,
                awaitingProviderResult: true,
            };
            const clientProjection = {
                schemaVersion: 1,
                source: 'client',
                adapterKind: 'openai-compatible',
                content: 'partial client text',
            };
            const providerProjection = {
                schemaVersion: 1,
                source: 'provider',
                adapterKind: 'openai-compatible',
                content: 'resolved provider output',
                journalBytes: 50,
            };
            createWorkflow('workflow-provider');
            createRound('workflow-provider', 'job-provider', 'execution-1', {
                bytes: 50,
                projection: pendingProjection,
            });
            const ordinaryClientAccepted = db.setGenerationJobClientProjection(
                'job-provider', clientProjection,
            );
            const secondRoundPendingProjection = {
                ...pendingProjection,
                content: 'intermediate provider text',
                journalBytes: 75,
            };
            const inheritedProjection = createRound(
                'workflow-provider', 'job-provider-round-2', 'execution-1',
                { bytes: 75, projection: secondRoundPendingProjection },
            );
            const readyWhilePending = db.listReadyChatWorkflowJobs();
            const secondRoundClientAccepted = db.setGenerationJobClientProjection(
                'job-provider-round-2', clientProjection,
            );
            const providerAccepted = db.setGenerationJobClientProjection(
                'job-provider-round-2', { ...providerProjection, journalBytes: 75 },
            );
            const readyAfterProvider = db.listReadyChatWorkflowJobs();
            const needsProjectionAfterProvider = db.listGenerationJobsNeedingProjection();
            const providerViaServerSetterAccepted = db.setGenerationJobProjection(
                'job-provider-round-2', providerProjection,
            );
            const serverRebuildAccepted = db.setGenerationJobProjection(
                'job-provider-round-2', { ...secondRoundPendingProjection, content: 'rebuilt server text' },
            );
            const laterClientAccepted = db.setGenerationJobClientProjection(
                'job-provider-round-2', clientProjection,
            );
            const job = db.getGenerationJob('job-provider-round-2');

            createWorkflow('workflow-retry');
            createRound('workflow-retry', 'job-retry-round-1', 'execution-retry-1', {
                bytes: 50,
                projection: pendingProjection,
            });
            const otherAttemptProjection = createRound(
                'workflow-retry', 'job-retry-round-2', 'execution-retry-2',
                {
                    bytes: 25,
                    projection: { ...pendingProjection, content: 'normal server output', awaitingProviderResult: false },
                },
            );
            const providerWithoutPendingAccepted = db.setGenerationJobClientProjection(
                'job-retry-round-2', { ...providerProjection, journalBytes: 25 },
            );
            process.stdout.write(JSON.stringify({
                readyWhilePending,
                ordinaryClientAccepted,
                inheritedProjection,
                secondRoundClientAccepted,
                providerAccepted,
                readyAfterProvider,
                needsProjectionAfterProvider,
                providerViaServerSetterAccepted,
                serverRebuildAccepted,
                laterClientAccepted,
                projection: job.projection,
                otherAttemptProjection,
                providerWithoutPendingAccepted,
            }));
        `
        try {
            const output = execFileSync(process.execPath, ['-e', script, databaseModule, providerBackend], {
                cwd: workingDirectory,
                encoding: 'utf8',
            })
            const result = JSON.parse(output)
            expect(result.readyWhilePending).toEqual([])
            expect(result.ordinaryClientAccepted).toBe(false)
            expect(result.inheritedProjection).toMatchObject({
                source: 'server',
                content: '',
                awaitingProviderResult: true,
            })
            expect(result.secondRoundClientAccepted).toBe(false)
            expect(result.providerAccepted).toBe(true)
            expect(result.readyAfterProvider.map((job: any) => job.jobId)).toEqual(['job-provider-round-2'])
            expect(result.needsProjectionAfterProvider).toEqual([])
            expect(result.providerViaServerSetterAccepted).toBe(false)
            expect(result.serverRebuildAccepted).toBe(false)
            expect(result.laterClientAccepted).toBe(false)
            expect(result.projection).toMatchObject({
                source: 'provider',
                content: 'resolved provider output',
                journalBytes: 75,
            })
            expect(result.otherAttemptProjection).toBeUndefined()
            expect(result.providerWithoutPendingAccepted).toBe(false)
        } finally {
            rmSync(workingDirectory, { recursive: true, force: true })
        }
    })
})
