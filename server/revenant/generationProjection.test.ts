import { describe, expect, it } from 'vitest'
import projectionPkg from './generationProjection.cjs'

const { createClientGenerationProjection, projectGenerationJournal } = projectionPkg as {
    createClientGenerationProjection: (
        job: Record<string, unknown>,
        content: string,
        providerResult?: boolean,
    ) => {
        schemaVersion: number
        source: string
        adapterKind: string
        content: string
        journalBytes?: number
    }
    projectGenerationJournal: (
        job: Record<string, unknown>,
        raw: Buffer,
    ) => Promise<{
        schemaVersion: number
        source: string
        adapterKind: string
        content: string
        journalBytes: number
        awaitingProviderResult?: boolean
    } | undefined>
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

    const openAi = (stream: boolean, reasoning?: { includeNative: boolean, thinkTagFallback: boolean }) => ({
        adapterKind: 'openai-compatible',
        responseDecoder: { adapterKind: 'openai-compatible', stream, ...(reasoning ? { reasoning } : {}) },
        responseStatus: 200,
    })

    it('projects an OpenAI-compatible JSON journal with the shared adapter parser', async () => {
        const journal = Buffer.from(JSON.stringify({
            choices: [{ message: { role: 'assistant', content: 'summary' } }],
        }))
        const projection = await projectGenerationJournal(openAi(false), journal)

        expect(projection).toEqual({
            schemaVersion: 1,
            source: 'server',
            adapterKind: 'openai-compatible',
            content: 'summary',
            journalBytes: journal.length,
        })
    })

    it('projects a streaming journal with the decoder options the adapter sent', async () => {
        const projection = await projectGenerationJournal(
            openAi(true, { includeNative: false, thinkTagFallback: true }),
            Buffer.from([
                'data: {"choices":[{"delta":{"content":"<think>plan</think>sum","reasoning_content":"hidden"}}]}',
                '',
                'data: {"choices":[{"delta":{"content":"mary"}}]}',
                '',
                'data: [DONE]',
                '',
            ].join('\n')),
        )

        expect(projection?.content).toBe('<Thoughts>\nplan\n</Thoughts>\n\nsummary')
    })

    it('does not project provider traffic that carries no chat response', async () => {
        await expect(projectGenerationJournal(
            { adapterKind: 'anthropic-messages', responseStatus: 200 },
            Buffer.from('{"id":"batch-1","processing_status":"in_progress"}'),
        )).resolves.toBeUndefined()
    })

    it.each([false, true])('waits for processed provider output on a tool-call turn (streaming=%s)', async streaming => {
        const turn = {
            choices: [{
                message: { content: null, tool_calls: [{
                    id: 'call-1', type: 'function',
                    function: { name: 'reply', arguments: '{"text":"Synthetic reply"}' },
                }] },
                finish_reason: 'tool_calls',
            }],
        }
        const journal = Buffer.from(streaming
            ? `data: ${JSON.stringify({ choices: [{ delta: turn.choices[0].message }] })}\n\n`
                + 'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\ndata: [DONE]\n\n'
            : JSON.stringify(turn))
        const job = openAi(streaming)
        const projection = await projectGenerationJournal(job, journal)

        expect(projection).toMatchObject({ content: '', awaitingProviderResult: true })
        expect(createClientGenerationProjection({ ...job, projection }, 'Processed reply', true)).toMatchObject({
            source: 'provider', content: 'Processed reply', journalBytes: journal.length,
        })

        const followup = await projectGenerationJournal({ ...openAi(false), projection }, Buffer.from(JSON.stringify({
            choices: [{ message: { content: 'Raw follow-up' }, finish_reason: 'stop' }],
        })))
        expect(followup).toMatchObject({ content: 'Raw follow-up', awaitingProviderResult: true })
    })

    it.each(['interrupted', 'cancelled'])('keeps a %s journal recoverable up to its last complete event', async status => {
        const projection = await projectGenerationJournal({ ...openAi(true), status }, Buffer.from([
            'data: {"choices":[{"delta":{"content":"partial"}}]}',
            '',
            'data: {"choices":[',
        ].join('\n')))

        expect(projection?.content).toBe('partial')
    })

    it('rejects provider error responses instead of projecting an error body', async () => {
        await expect(projectGenerationJournal(
            { ...openAi(false), responseStatus: 429 },
            Buffer.from('{"error":"rate limited"}'),
        )).rejects.toThrow('HTTP 429')
    })
})
