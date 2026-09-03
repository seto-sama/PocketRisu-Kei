import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

describe('server-owned main generation terminal state', () => {
    it('keeps the workflow active so a failed provider round can be retried', () => {
        const workingDirectory = mkdtempSync(resolve(tmpdir(), 'pocketrisu-main-failure-'))
        const databaseModule = resolve('server/node/revenant/generationDb.cjs')
        const script = String.raw`
            const db = require(process.argv[1]);
            db.createGenerationWorkflow({
                workflowId: 'workflow-1', characterId: 'character-1', roomId: 'room-1',
                context: { schemaVersion: 1, kind: 'chat-generation' },
                plan: [
                    { key: 'model.main', kind: 'model.main', recoveryPolicy: 'replay_output', status: 'pending', order: 0 },
                    { key: 'output.transform', kind: 'postprocess.output.transform', recoveryPolicy: 'resume', status: 'pending', order: 1 },
                ],
            });
            db.createGenerationJob({
                jobId: 'job-1', chatId: 'message-1', jobType: 'model',
                characterId: 'character-1', roomId: 'room-1', workflowId: 'workflow-1',
                workflowStepKey: 'model.main', stepExecutionId: 'execution-1',
            });
            db.finishGenerationJob('job-1', 'failed', 'upstream_error', 'provider exploded');
            const afterFailure = db.getGenerationWorkflow('workflow-1');
            db.createGenerationJob({
                jobId: 'job-2', chatId: 'message-1', jobType: 'model',
                characterId: 'character-1', roomId: 'room-1', workflowId: 'workflow-1',
                workflowStepKey: 'model.main', stepExecutionId: 'execution-1',
            });
            process.stdout.write(JSON.stringify({
                workflow: db.getGenerationWorkflow('workflow-1'),
                afterFailure,
                jobs: db.listGenerationWorkflowJobs('workflow-1'),
            }));
        `
        try {
            const result = JSON.parse(execFileSync(
                process.execPath,
                ['-e', script, databaseModule],
                { cwd: workingDirectory, encoding: 'utf8' },
            ))
            expect(result.afterFailure.status).toBe('active')
            expect(result.afterFailure.steps[0]).toMatchObject({
                key: 'model.main',
                status: 'failed',
                metadata: { error: 'provider exploded' },
            })
            expect(result.afterFailure.steps[1]).toMatchObject({ status: 'pending' })
            expect(result.workflow.status).toBe('active')
            expect(result.workflow.steps[0]).toMatchObject({
                key: 'model.main',
                status: 'waiting_job',
            })
            expect(result.jobs[0]).toMatchObject({
                status: 'failed',
                finishReason: 'upstream_error',
            })
            expect(result.jobs[0].materializedAt).toBeTypeOf('number')
            expect(result.jobs[1]).toMatchObject({ status: 'queued' })
        }
        finally {
            rmSync(workingDirectory, { recursive: true, force: true })
        }
    })

    it('acknowledges an older terminal room job before a new workflow starts', () => {
        const workingDirectory = mkdtempSync(resolve(tmpdir(), 'pocketrisu-terminal-room-'))
        const databaseModule = resolve('server/node/revenant/generationDb.cjs')
        const script = String.raw`
            const db = require(process.argv[1]);
            db.createGenerationWorkflow({
                workflowId: 'workflow-1', characterId: 'character-1', roomId: 'room-1',
                context: { schemaVersion: 1, kind: 'chat-generation' },
                plan: [
                    { key: 'model.main', kind: 'model.main', recoveryPolicy: 'replay_output', status: 'pending', order: 0 },
                ],
            });
            db.createGenerationJob({
                jobId: 'job-1', chatId: 'message-1', jobType: 'model',
                characterId: 'character-1', roomId: 'room-1', workflowId: 'workflow-1',
                workflowStepKey: 'model.main', stepExecutionId: 'execution-1',
            });
            db.finishGenerationJob('job-1', 'cancelled', 'user_cancelled');
            db.cancelGenerationWorkflow('workflow-1', 'cancelled');
            const before = db.getGenerationJob('job-1', false);
            const changed = db.acknowledgeTerminalGenerationJobsForRoom('character-1', 'room-1');
            const after = db.getGenerationJob('job-1', false);
            process.stdout.write(JSON.stringify({ before, changed, after }));
        `
        try {
            const result = JSON.parse(execFileSync(
                process.execPath,
                ['-e', script, databaseModule],
                { cwd: workingDirectory, encoding: 'utf8' },
            ))
            expect(result.before.materializedAt).toBeNull()
            expect(result.changed).toBe(1)
            expect(result.after.materializedAt).toBeTypeOf('number')
        }
        finally {
            rmSync(workingDirectory, { recursive: true, force: true })
        }
    })
})
