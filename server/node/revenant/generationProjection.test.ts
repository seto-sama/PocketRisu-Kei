import { describe, expect, it } from 'vitest'
import projectionPkg from './generationProjection.cjs'

const { createClientGenerationProjection, projectGenerationJournal } = projectionPkg as {
    createClientGenerationProjection: (
        job: Record<string, unknown>,
        content: string,
    ) => {
        schemaVersion: number
        source: string
        adapterKind: string
        content: string
    }
    projectGenerationJournal: (
        job: Record<string, unknown>,
        raw: Buffer,
    ) => Promise<{
        schemaVersion: number
        source: string
        adapterKind: string
        content: string
    }>
}

describe('generation normalized projection', () => {
    it('labels a live client checkpoint as a derived client projection', () => {
        expect(createClientGenerationProjection({
            adapterKind: 'anthropic-messages',
        }, 'partial')).toEqual({
            schemaVersion: 1,
            source: 'client',
            adapterKind: 'anthropic-messages',
            content: 'partial',
        })
    })

    it('projects an OpenAI-compatible JSON journal with the shared adapter parser', async () => {
        const projection = await projectGenerationJournal({
            adapterKind: 'openai-compatible',
            streaming: false,
            responseStatus: 200,
            responseHeaders: { 'content-type': 'application/json' },
        }, Buffer.from(JSON.stringify({
            choices: [{ message: { role: 'assistant', content: 'summary' } }],
        })))

        expect(projection).toEqual({
            schemaVersion: 1,
            source: 'server',
            adapterKind: 'openai-compatible',
            content: 'summary',
        })
    })

    it('projects a streaming journal after the client has disconnected', async () => {
        const projection = await projectGenerationJournal({
            adapterKind: 'openai-compatible',
            streaming: true,
            responseStatus: 200,
            responseHeaders: { 'content-type': 'text/event-stream' },
        }, Buffer.from([
            'data: {"choices":[{"delta":{"content":"sum"}}]}',
            '',
            'data: {"choices":[{"delta":{"content":"mary"}}]}',
            '',
            'data: [DONE]',
            '',
        ].join('\n')))

        expect(projection.content).toBe('summary')
    })

    it('keeps an interrupted journal recoverable up to its last complete event', async () => {
        const projection = await projectGenerationJournal({
            adapterKind: 'openai-compatible',
            streaming: true,
            status: 'interrupted',
            responseStatus: 200,
            responseHeaders: { 'content-type': 'text/event-stream' },
        }, Buffer.from([
            'data: {"choices":[{"delta":{"content":"partial"}}]}',
            '',
            'data: {"choices":[',
        ].join('\n')))

        expect(projection.content).toBe('partial')
    })

    it('projects a cancelled stream through its last complete journal event', async () => {
        const projection = await projectGenerationJournal({
            adapterKind: 'openai-compatible',
            streaming: true,
            status: 'cancelled',
            responseStatus: 200,
            responseHeaders: { 'content-type': 'text/event-stream' },
        }, Buffer.from([
            'data: {"choices":[{"delta":{"content":"kept partial"}}]}',
            '',
            'data: {"choices":[',
        ].join('\n')))

        expect(projection.content).toBe('kept partial')
    })

    it('rejects provider error responses instead of projecting an error body', async () => {
        await expect(projectGenerationJournal({
            adapterKind: 'openai-compatible',
            streaming: false,
            responseStatus: 429,
            responseHeaders: { 'content-type': 'application/json' },
        }, Buffer.from('{"error":"rate limited"}'))).rejects.toThrow('HTTP 429')
    })
})
