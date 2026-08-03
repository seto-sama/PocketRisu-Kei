import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

describe('generation workflow step executions', () => {
    it('groups multiple provider jobs under one attempt and preserves later attempts', () => {
        const workingDirectory = mkdtempSync(resolve(tmpdir(), 'pocketrisu-step-execution-'))
        const databaseModule = resolve('server/node/revenant/generationDb.cjs')
        const script = String.raw`
            const db = require(process.argv[1]);
            db.createGenerationWorkflow({
                workflowId: 'workflow-1',
                characterId: 'character-1',
                roomId: 'room-1',
                ownerClientId: 'client-1',
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
                isContinuation: false,
            });
            create('job-1', 'execution-1');
            db.finishGenerationJob('job-1', 'generated', 'provider_complete');
            create('job-2', 'execution-1');
            db.finishGenerationJob('job-2', 'generated', 'provider_complete');
            create('job-3', 'execution-2');
            const beforeCancel = db.getGenerationWorkflow('workflow-1');
            const claimed = db.claimGenerationWorkflow(
                'workflow-1', 'client-2', 'client-1', 1,
            );
            const staleClaim = db.claimGenerationWorkflow(
                'workflow-1', 'client-3', 'client-2', 1,
            );
            const cancellation = db.cancelGenerationStepExecution(
                'workflow-1', 'execution-2',
            );
            const workflow = db.getGenerationWorkflow('workflow-1');
            const jobs = db.listGenerationWorkflowJobs('workflow-1');
            process.stdout.write(JSON.stringify({
                workflow, jobs, claimed, staleClaim, beforeCancel, cancellation,
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
            expect(result.claimed).toMatchObject({ ownerClientId: 'client-2', ownerEpoch: 2 })
            expect(result.staleClaim).toBeNull()
            expect(result.workflow).toMatchObject({ ownerClientId: 'client-2', ownerEpoch: 2 })
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
})
