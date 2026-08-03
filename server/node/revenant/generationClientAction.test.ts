import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

describe('generation workflow client actions', () => {
    it('leases one waiting action without relying on workflow ownership', () => {
        const workingDirectory = mkdtempSync(resolve(tmpdir(), 'pocketrisu-client-action-'))
        const databaseModule = resolve('server/node/revenant/generationDb.cjs')
        const script = String.raw`
            const db = require(process.argv[1]);
            db.createGenerationWorkflow({
                workflowId: 'workflow-1', characterId: 'character-1', roomId: 'room-1',
                context: { schemaVersion: 1, kind: 'chat-generation' },
                plan: [{ key: 'trigger.output', kind: 'postprocess.trigger.output', recoveryPolicy: 'resume', status: 'pending', order: 0 }],
            });
            db.updateGenerationWorkflowStep('workflow-1', 'trigger.output', {
                status: 'waiting_client',
                metadata: { schemaVersion: 1, action: { actionId: 'trigger.0.provider', kind: 'provider.llm' } },
            });
            const first = db.claimGenerationWorkflowClientAction(
                'workflow-1', 'trigger.output', 'trigger.0.provider', 'new-client', 60000,
            );
            const busy = db.claimGenerationWorkflowClientAction(
                'workflow-1', 'trigger.output', 'trigger.0.provider', 'other-client', 60000,
            );
            db.createGenerationJob({
                jobId: 'child-job-1', chatId: 'aux-1', jobType: 'otherAx',
                characterId: 'character-1', roomId: 'room-1', workflowId: 'workflow-1',
                workflowStepKey: 'client-action:trigger.0.provider', stepExecutionId: 'execution-1',
            });
            db.finishGenerationJob('child-job-1', 'generated', 'provider_complete');
            const stale = db.resolveGenerationWorkflowClientAction(
                'workflow-1', 'trigger.output', 'trigger.0.provider', 'other-client', { result: 'wrong' },
            );
            const resolved = db.resolveGenerationWorkflowClientAction(
                'workflow-1', 'trigger.output', 'trigger.0.provider', 'new-client', { result: 'ok' },
            );
            const duplicate = db.resolveGenerationWorkflowClientAction(
                'workflow-1', 'trigger.output', 'trigger.0.provider', 'new-client', { result: 'ignored' },
            );
            const consumed = db.consumeGenerationWorkflowClientActionJobs('workflow-1', 'trigger.0.provider');
            process.stdout.write(JSON.stringify({
                first, busy, stale, resolved, duplicate, consumed,
                workflow: db.getGenerationWorkflow('workflow-1'),
                child: db.getGenerationJob('child-job-1', false),
            }));
        `
        try {
            const output = execFileSync(process.execPath, ['-e', script, databaseModule], {
                cwd: workingDirectory,
                encoding: 'utf8',
            })
            const result = JSON.parse(output)
            expect(result.first).toMatchObject({ busy: false, claim: { clientId: 'new-client' } })
            expect(result.busy).toMatchObject({ busy: true, claim: { clientId: 'new-client' } })
            expect(result.stale).toMatchObject({ staleClaim: true })
            expect(result.resolved).toEqual({ alreadyResolved: false })
            expect(result.duplicate).toEqual({ alreadyResolved: true })
            expect(result.consumed).toBe(1)
            expect(result.child.materializedAt).toBeTypeOf('number')
            expect(result.workflow).not.toHaveProperty('ownerEpoch')
            expect(result.workflow).not.toHaveProperty('ownerClientId')
            expect(result.workflow.steps[0]).toMatchObject({
                status: 'pending',
                metadata: { responses: { 'trigger.0.provider': { result: 'ok' } } },
            })
            expect(result.workflow.steps[1]).toMatchObject({
                key: 'client-action:trigger.0.provider',
                status: 'completed',
            })
        } finally {
            rmSync(workingDirectory, { recursive: true, force: true })
        }
    })
})
