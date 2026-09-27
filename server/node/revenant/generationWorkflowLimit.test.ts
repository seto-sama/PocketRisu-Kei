import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

describe('global Revenant workflow limit', () => {
    it('limits all active workflow kinds while preserving per-room busy behavior', () => {
        const workingDirectory = mkdtempSync(resolve(tmpdir(), 'pocketrisu-workflow-limit-'))
        const databaseModule = resolve('server/node/revenant/generationDb.cjs')
        const capacityModule = resolve('server/node/revenant/capacity.cjs')
        const script = String.raw`
            const db = require(process.argv[1]);
            const { REVENANT_CAPACITY } = require(process.argv[2]);
            const create = (index, kind = 'chat-generation') => db.createGenerationWorkflow({
                workflowId: 'workflow-' + index,
                characterId: 'character-' + index,
                roomId: 'room-' + index,
                context: { schemaVersion: 1, kind },
                plan: [{ key: 'step', kind: 'provider', recoveryPolicy: 'replay_output', status: 'pending', order: 0 }],
            });
            for (let index = 0; index < REVENANT_CAPACITY.maxActiveWorkflows; index++) {
                create(index, index % 2 ? 'image-generation' : 'chat-generation');
            }
            const sameRoom = db.createGenerationWorkflow({
                workflowId: 'duplicate-room',
                characterId: 'character-0',
                roomId: 'room-0',
                context: { schemaVersion: 1, kind: 'image-generation' },
                plan: [{ key: 'step', kind: 'image.generate.server', recoveryPolicy: 'at_least_once', status: 'pending', order: 0 }],
            });
            let overflow;
            try { create('overflow', 'image-generation'); }
            catch (error) { overflow = { code: error.code, status: error.httpStatus, details: error.details }; }
            db.finishGenerationWorkflow('workflow-0', 'completed');
            const afterRelease = create('after-release', 'image-generation');
            process.stdout.write(JSON.stringify({
                capacity: REVENANT_CAPACITY,
                sameRoom: { busy: sameRoom.busy, workflowId: sameRoom.workflow.workflowId },
                overflow,
                afterRelease: { busy: afterRelease.busy, workflowId: afterRelease.workflow.workflowId },
            }));
        `
        try {
            const result = JSON.parse(execFileSync(
                process.execPath,
                ['-e', script, databaseModule, capacityModule],
                { cwd: workingDirectory, encoding: 'utf8' },
            ))
            expect(result.capacity.maxActiveWorkflows).toBeGreaterThan(0)
            expect(result.capacity.maxActiveProviderJobs).toBeGreaterThan(0)
            expect(result.sameRoom).toEqual({ busy: true, workflowId: 'workflow-0' })
            expect(result.overflow).toEqual({
                code: 'REVENANT_WORKFLOW_LIMIT',
                status: 429,
                details: { limit: result.capacity.maxActiveWorkflows },
            })
            expect(result.afterRelease).toEqual({
                busy: false,
                workflowId: 'workflow-after-release',
            })
        } finally {
            rmSync(workingDirectory, { recursive: true, force: true })
        }
    })
})
