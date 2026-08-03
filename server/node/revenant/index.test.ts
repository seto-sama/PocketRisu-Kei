import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

describe('revenant server public entrypoint', () => {
    it('exposes the server integration surface from one module', () => {
        const workingDirectory = mkdtempSync(join(tmpdir(), 'risu-revenant-index-'))
        const modulePath = fileURLToPath(new URL('./index.cjs', import.meta.url))
        const expected = [
            'generationDb',
            'getGenerationJob',
            'generationJournalStore',
            'projectGenerationJournal',
            'installRevenantGenerationRoutes',
            'createGenerationWorkers',
            'createRevenantMaterializer',
            'createRevenantPostprocessWorker',
            'createGenerationWorkflowService',
            'normalizeGenerationRequestTimeoutMs',
            'streamRevenantJournal',
        ]
        const script = `
            const api = require(process.argv[1]);
            const expected = JSON.parse(process.argv[2]);
            process.stdout.write(JSON.stringify(expected.filter(key => !(key in api))));
        `
        try {
            const missing = JSON.parse(execFileSync(
                process.execPath,
                ['-e', script, modulePath, JSON.stringify(expected)],
                { cwd: workingDirectory, encoding: 'utf8' },
            ))
            expect(missing).toEqual([])
        }
        finally {
            rmSync(workingDirectory, { recursive: true, force: true })
        }
    })
})
