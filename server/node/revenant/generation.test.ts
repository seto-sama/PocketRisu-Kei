import { describe, expect, it } from 'vitest'
import streamPkg from './generationStream.cjs'

const { notifyRevenantJournalWaiters, streamRevenantJournal, sendRevenantJournalEvent } = streamPkg as {
    notifyRevenantJournalWaiters: (job: any) => void
    streamRevenantJournal: (
        ws: FakeSocket,
        job: any,
        offset: number,
        store: { readChunk: (jobId: string, offset: number) => Promise<{ offset: number, bytes: Buffer }> },
    ) => Promise<void>
    sendRevenantJournalEvent: (ws: FakeSocket, job: any, event: object) => void
}

class FakeSocket {
    journalRecoverySubscriber = false
    messages: any[] = []
    send(value: string): void {
        this.messages.push(JSON.parse(value))
    }
}

describe('revenant journal stream', () => {
    const job = {
        id: 'job-1',
        responseStatus: 200,
        responseHeaders: { 'content-type': 'text/event-stream' },
        rawBytes: 6,
        done: true,
        terminalEvent: { type: 'done' },
    }

    it('sends headers, the requested byte suffix, and terminal state', async () => {
        const socket = new FakeSocket()
        const journal = Buffer.from('abcdef')
        await streamRevenantJournal(socket, job, 3, {
            async readChunk(_jobId, offset) {
                return { offset, bytes: journal.subarray(offset) }
            },
        })
        expect(socket.messages.map(message => message.type)).toEqual([
            'upstream_headers',
            'chunk',
            'done',
        ])
        expect(Buffer.from(socket.messages[1].dataBase64, 'base64').toString()).toBe('def')
    })

    it('turns an errored partial journal into a clean recovery tail', () => {
        const socket = new FakeSocket()
        socket.journalRecoverySubscriber = true
        sendRevenantJournalEvent(socket, job, { type: 'error', message: 'lost' })
        expect(socket.messages[0]).toMatchObject({ type: 'done', partial: true })
    })

    it('tails bytes appended after the socket reaches EOF', async () => {
        const socket = new FakeSocket()
        const liveJob = {
            ...job,
            rawBytes: 0,
            done: false,
            journalWaiters: [],
        }
        let journal = Buffer.alloc(0)
        const streaming = streamRevenantJournal(socket, liveJob, 0, {
            async readChunk(_jobId, offset) {
                return { offset, bytes: journal.subarray(offset) }
            },
        })

        while (liveJob.journalWaiters.length === 0) await Promise.resolve()
        journal = Buffer.from('later')
        liveJob.rawBytes = journal.length
        notifyRevenantJournalWaiters(liveJob)
        while (!socket.messages.some(message => message.type === 'chunk')) await Promise.resolve()
        liveJob.done = true
        notifyRevenantJournalWaiters(liveJob)
        await streaming

        const chunk = socket.messages.find(message => message.type === 'chunk')
        expect(Buffer.from(chunk.dataBase64, 'base64').toString()).toBe('later')
        expect(socket.messages.at(-1)?.type).toBe('done')
    })
})
