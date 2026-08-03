import { afterEach, describe, expect, it } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import pkg from './generationJournal.cjs'

const { createGenerationJournalStore } = pkg as {
    createGenerationJournalStore: (options: { revenantDir: string }) => {
        journalKey: (workflowId: string | null, jobId: string) => string
        create: (workflowId: string | null, jobId: string) => string
        openWriter: (workflowId: string | null, jobId: string) => fs.WriteStream
        readAll: (workflowId: string | null, jobId: string) => Buffer
        readChunk: (workflowId: string | null, jobId: string, offset: number) => Promise<{ offset: number, bytes: Buffer }>
        size: (workflowId: string | null, jobId: string) => number
        removeOrphans: (validJournals: Set<string>, olderThan: number) => number
    }
}

const tempDirs: string[] = []

afterEach(() => {
    for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

function makeStore() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'revenant-journal-'))
    tempDirs.push(dir)
    return createGenerationJournalStore({ revenantDir: path.join(dir, 'revenant') })
}

describe('generation journal store', () => {
    it('appends provider bytes and replays from a byte offset', async () => {
        const store = makeStore()
        const journalPath = store.create('workflow-1', 'job-1')
        const writer = store.openWriter('workflow-1', 'job-1')
        writer.write(Buffer.from('provider-'))
        writer.end(Buffer.from('bytes'))
        await new Promise<void>((resolve, reject) => {
            writer.once('close', resolve)
            writer.once('error', reject)
        })

        expect(journalPath).toContain(path.join('workflow-1', 'job-1.journal'))
        expect(store.size('workflow-1', 'job-1')).toBe(14)
        expect(store.readAll('workflow-1', 'job-1').toString()).toBe('provider-bytes')
        const replay = await store.readChunk('workflow-1', 'job-1', 9)
        expect(replay.offset).toBe(9)
        expect(replay.bytes.toString()).toBe('bytes')
    })

    it('removes only old orphan journals', () => {
        const store = makeStore()
        const keptPath = store.create('workflow-kept', 'kept')
        const orphanPath = store.create('workflow-orphan', 'orphan')
        fs.utimesSync(keptPath, new Date(0), new Date(0))
        fs.utimesSync(orphanPath, new Date(0), new Date(0))

        expect(store.removeOrphans(
            new Set([store.journalKey('workflow-kept', 'kept')]),
            Date.now(),
        )).toBe(1)
        expect(store.size('workflow-kept', 'kept')).toBe(0)
        expect(fs.existsSync(orphanPath)).toBe(false)
        expect(fs.existsSync(path.dirname(orphanPath))).toBe(false)
    })
})
