import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { expect, it } from 'vitest'

it('persists provider bytes as a BLOB and preserves them through queue claim', () => {
    const directory = mkdtempSync(resolve(tmpdir(), 'pocketrisu-binary-dispatch-'))
    try {
        const result = JSON.parse(execFileSync(process.execPath, ['-e', `
            const path = require('path');
            const base = process.argv[1];
            const repository = require(path.join(base, 'generationDb.cjs'));
            const { db } = require(path.join(base, 'persistence/connection.cjs'));
            const body = Buffer.from([0, 255, 128, 0xea, 0xb0]);
            repository.createSingleGenerationJob({
                jobId: 'binary', jobType: 'otherAx', dispatchGroup: 'group',
                dispatchMaxConcurrent: 1, dispatchRequestsPerMinute: 100,
                requestSpec: { targetUrl: 'https://example.test', method: 'POST', body },
            });
            const stored = db.prepare('SELECT typeof(request_spec) AS type FROM generation_jobs WHERE job_id = ?').get('binary');
            const queued = repository.listQueuedGenerationDispatches()[0];
            const claimed = repository.claimQueuedGenerationDispatch('binary');
            process.stdout.write(JSON.stringify({
                type: stored.type, queued: [...queued.requestSpec.body], claimed: [...claimed.requestSpec.body],
                targetUrl: claimed.requestSpec.targetUrl,
                cleared: db.prepare('SELECT request_spec FROM generation_jobs WHERE job_id = ?').get('binary').request_spec,
            }));
        `, resolve('server/node/revenant')], { cwd: directory, encoding: 'utf8' }))
        expect(result).toEqual({
            type: 'blob', queued: [0, 255, 128, 234, 176], claimed: [0, 255, 128, 234, 176],
            targetUrl: 'https://example.test', cleared: null,
        })
    } finally { rmSync(directory, { recursive: true, force: true }) }
})

it('owns standalone requests in independent one-step workflows and retains consumed terminal jobs', () => {
    const directory = mkdtempSync(resolve(tmpdir(), 'pocketrisu-single-request-'))
    try {
        const result = JSON.parse(execFileSync(process.execPath, ['-e', `
            const db = require(process.argv[1]);
            const out = [];
            for (const [jobId, status] of [['translation', 'generated'], ['test', 'failed'], ['cancel', 'cancelled']]) {
                const job = db.createSingleGenerationJob({ jobId, jobType: 'translate',
                    characterId: 'character', roomId: 'room', chatId: jobId });
                db.setGenerationJobGenerating(jobId);
                db.finishGenerationJob(jobId, status, status);
                db.markGenerationMaterialized(jobId);
                out.push({ workflow: db.getGenerationWorkflow(job.workflowId), jobs: db.listGenerationWorkflowJobs(job.workflowId) });
            }
            const test = db.createSingleGenerationJob({ jobId: 'preset-test', jobType: 'otherAx' });
            db.finishGenerationJob(test.jobId, 'generated', 'done');
            process.stdout.write(JSON.stringify(out));
        `, resolve('server/node/revenant/generationDb.cjs')], { cwd: directory, encoding: 'utf8' }))
        expect(result.map(item => item.workflow.status)).toEqual(['completed', 'failed', 'cancelled'])
        for (const item of result) {
            expect(item.workflow.steps).toHaveLength(1)
            expect(item.jobs).toHaveLength(1)
            expect(item.jobs[0].roomId).toBe('room')
            expect(item.jobs[0].materializedAt).toBeTypeOf('number')
        }
    } finally { rmSync(directory, { recursive: true, force: true }) }
})
