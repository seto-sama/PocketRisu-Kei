import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { expect, it } from 'vitest'

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
