import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

describe('server-owned main generation terminal state', () => {
    it('fails the workflow when its durable main provider job fails', () => {
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
            process.stdout.write(JSON.stringify({
                workflow: db.getGenerationWorkflow('workflow-1'),
                job: db.getGenerationJob('job-1', false),
            }));
        `
        try {
            const result = JSON.parse(execFileSync(
                process.execPath,
                ['-e', script, databaseModule],
                { cwd: workingDirectory, encoding: 'utf8' },
            ))
            expect(result.workflow.status).toBe('failed')
            expect(result.workflow.steps[0]).toMatchObject({
                key: 'model.main',
                status: 'failed',
                metadata: { error: 'provider exploded' },
            })
            expect(result.workflow.steps[1]).toMatchObject({ status: 'failed' })
            expect(result.job).toMatchObject({
                status: 'failed',
                finishReason: 'upstream_error',
            })
            expect(result.job.materializedAt).toBeTypeOf('number')
        }
        finally {
            rmSync(workingDirectory, { recursive: true, force: true })
        }
    })
})
