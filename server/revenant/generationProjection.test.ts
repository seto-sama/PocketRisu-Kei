import { describe, expect, it, vi } from 'vitest'
import projectionPkg from './generationProjection.cjs'

const { createClientGenerationProjection, openGenerationEventJournal, projectGenerationJournal } = projectionPkg as {
    openGenerationEventJournal: (
        job: Record<string, unknown>,
        options: { journalStore: { openWriter: () => unknown }, onWritten: () => void },
    ) => {
        push: (bytes: Buffer) => void
        finish: (partial: boolean) => Promise<{ content: string, journalBytes: number }>
    }
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
        projection: {
            schemaVersion: number
            source: string
            adapterKind: string
            content: string
            journalBytes: number
            awaitingProviderResult?: boolean
        }
        events: Buffer
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
        const rebuilt = await projectGenerationJournal(openAi(false), journal)

        expect(rebuilt?.projection).toEqual({
            schemaVersion: 1,
            source: 'server',
            adapterKind: 'openai-compatible',
            content: 'summary',
            journalBytes: journal.length,
        })
        expect(rebuilt?.events.toString().split('\n').filter(Boolean).map(line => JSON.parse(line))).toEqual([
            { type: 'response', response: expect.objectContaining({ text: 'summary' }) },
        ])
    })

    it('projects a streaming journal with the decoder options the adapter sent', async () => {
        const rebuilt = await projectGenerationJournal(
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

        expect(rebuilt?.projection.content).toBe('<Thoughts>\nplan\n</Thoughts>\n\nsummary')
    })

    it('leaves generated images for the browser to store and post back', async () => {
        const rebuilt = await projectGenerationJournal(
            { ...openAi(false), responseDecoder: { adapterKind: 'openai-compatible', stream: false, imageGeneration: true } },
            Buffer.from(JSON.stringify({ data: [{ b64_json: 'aW1hZ2U=' }] })),
        )

        expect(rebuilt?.projection).toMatchObject({ content: '', awaitingProviderResult: true })
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
        const projection = (await projectGenerationJournal(job, journal))?.projection

        expect(projection).toMatchObject({ content: '', awaitingProviderResult: true })
        expect(createClientGenerationProjection({ ...job, projection }, 'Processed reply', true)).toMatchObject({
            source: 'provider', content: 'Processed reply', journalBytes: journal.length,
        })

        const followup = (await projectGenerationJournal({ ...openAi(false), projection }, Buffer.from(JSON.stringify({
            choices: [{ message: { content: 'Raw follow-up' }, finish_reason: 'stop' }],
        }))))?.projection
        expect(followup).toMatchObject({ content: 'Raw follow-up', awaitingProviderResult: true })
    })

    it.each(['interrupted', 'cancelled'])('keeps a %s journal recoverable up to its last complete event', async status => {
        const rebuilt = await projectGenerationJournal({ ...openAi(true), status }, Buffer.from([
            'data: {"choices":[{"delta":{"content":"partial"}}]}',
            '',
            'data: {"choices":[',
        ].join('\n')))

        expect(rebuilt?.projection.content).toBe('partial')
    })

    it('rejects provider error responses instead of projecting an error body', async () => {
        await expect(projectGenerationJournal(
            { ...openAi(false), responseStatus: 429 },
            Buffer.from('{"error":"rate limited"}'),
        )).rejects.toThrow('HTTP 429')
    })

    it('writes decoded events while provider bytes are still arriving', async () => {
        const written: string[] = []
        const writer = {
            on: vi.fn(),
            write: (line: string, done: () => void) => { written.push(line); done() },
            end: (done: () => void) => done(),
        }
        const onWritten = vi.fn()
        const journal = openGenerationEventJournal(
            { ...openAi(true), jobId: 'job-1', workflowId: 'workflow-1' },
            { journalStore: { openWriter: () => writer }, onWritten },
        )
        const sse = Buffer.from('data: {"choices":[{"delta":{"content":"Hel"}}]}\n\ndata: {"choices":[{"delta":{"content":"lo"}}]}\n\n')

        journal.push(sse.subarray(0, 60))
        await vi.waitFor(() => expect(written).toHaveLength(1))
        journal.push(sse.subarray(60))
        const projection = await journal.finish(false)

        expect(written.map(line => JSON.parse(line).delta.textDelta)).toEqual(['Hel', 'lo'])
        expect(projection).toMatchObject({ content: 'Hello', journalBytes: sse.length })
        expect(onWritten).toHaveBeenCalled()
    })
})
