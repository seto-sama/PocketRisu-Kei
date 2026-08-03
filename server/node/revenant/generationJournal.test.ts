import { afterEach, describe, expect, it } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import pkg from './generationJournal.cjs'

const { createGenerationJournalStore } = pkg as {
    createGenerationJournalStore: (options: { journalDir: string }) => {
        create: (jobId: string) => string
        openWriter: (jobId: string) => fs.WriteStream
        readAll: (jobId: string) => Buffer
        readChunk: (jobId: string, offset: number) => Promise<{ offset: number, bytes: Buffer }>
        size: (jobId: string) => number
        removeOrphans: (validJobIds: Set<string>, olderThan: number) => number
    }
}

const tempDirs: string[] = []

afterEach(() => {
    for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

function makeStore() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'revenant-journal-'))
    tempDirs.push(dir)
    return createGenerationJournalStore({ journalDir: path.join(dir, 'journals') })
}

describe('generation journal store', () => {
    it('appends provider bytes and replays from a byte offset', async () => {
        const store = makeStore()
        store.create('job-1')
        const writer = store.openWriter('job-1')
        writer.write(Buffer.from('provider-'))
        writer.end(Buffer.from('bytes'))
        await new Promise<void>((resolve, reject) => {
            writer.once('close', resolve)
            writer.once('error', reject)
        })

        expect(store.size('job-1')).toBe(14)
        expect(store.readAll('job-1').toString()).toBe('provider-bytes')
        const replay = await store.readChunk('job-1', 9)
        expect(replay.offset).toBe(9)
        expect(replay.bytes.toString()).toBe('bytes')
    })

    it('removes only old orphan journals', () => {
        const store = makeStore()
        const keptPath = store.create('kept')
        const orphanPath = store.create('orphan')
        fs.utimesSync(keptPath, new Date(0), new Date(0))
        fs.utimesSync(orphanPath, new Date(0), new Date(0))

        expect(store.removeOrphans(new Set(['kept']), Date.now())).toBe(1)
        expect(store.size('kept')).toBe(0)
        expect(fs.existsSync(orphanPath)).toBe(false)
    })
})
