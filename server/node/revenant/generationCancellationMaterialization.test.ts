import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

describe('server-owned cancellation materialization', () => {
    it('retains the cancelled model projection until the materializer commits it', () => {
        const workingDirectory = mkdtempSync(resolve(tmpdir(), 'pocketrisu-cancel-materialize-'))
        const databaseModule = resolve('server/node/revenant/generationDb.cjs')
        const script = String.raw`
            const db = require(process.argv[1]);
            db.createGenerationWorkflow({
                workflowId: 'workflow-1', characterId: 'character-1', roomId: 'room-1',
                context: { schemaVersion: 1, kind: 'chat-generation' },
                plan: [{ key: 'model.main', kind: 'model.main', recoveryPolicy: 'replay_output', status: 'pending', order: 0 }],
            });
            db.createGenerationJob({
                jobId: 'model-job', chatId: 'message-1', jobType: 'model',
                characterId: 'character-1', roomId: 'room-1', workflowId: 'workflow-1',
                workflowStepKey: 'model.main', stepExecutionId: 'execution-1',
            });
            db.createGenerationJob({
                jobId: 'aux-job', chatId: 'aux-1', jobType: 'otherAx',
                characterId: 'character-1', roomId: 'room-1', workflowId: 'workflow-1',
                workflowStepKey: 'model.main', stepExecutionId: 'execution-2',
            });
            db.cancelGenerationWorkflow('workflow-1', 'cancelled');
            process.stdout.write(JSON.stringify({
                model: db.getGenerationJob('model-job', false),
                auxiliary: db.getGenerationJob('aux-job', false),
            }));
        `
        try {
            const result = JSON.parse(execFileSync(
                process.execPath,
                ['-e', script, databaseModule],
                { cwd: workingDirectory, encoding: 'utf8' },
            ))
            expect(result.model.status).toBe('cancelled')
            expect(result.model.materializedAt).toBeNull()
            expect(result.auxiliary.materializedAt).toBeTypeOf('number')
        }
        finally {
            rmSync(workingDirectory, { recursive: true, force: true })
        }
    })
})
