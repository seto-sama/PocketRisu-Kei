import { describe, expect, it, vi } from 'vitest'
import { decodeRevenantGenerationJournal } from './journalDecoder'
import type { RecoverableGenerationJob } from '../types'

function streamText(...parts: string[]): ReadableStream<Uint8Array> {
    const encoder = new TextEncoder()
    return new ReadableStream({
        start(controller) {
            for (const part of parts) controller.enqueue(encoder.encode(part))
            controller.close()
        },
    })
}

function job(overrides: Partial<RecoverableGenerationJob>): RecoverableGenerationJob {
    return {
        jobId: 'job-1',
        chatId: 'message-1',
        status: 'generated',
        createdAt: 1,
        updatedAt: 2,
        ...overrides,
    }
}

describe('decodeRevenantGenerationJournal', () => {
    it('replays OpenAI-compatible SSE through the client adapter parser', async () => {
        const onContent = vi.fn()
        const onProgress = vi.fn()
        const content = await decodeRevenantGenerationJournal(
            job({ adapterKind: 'openai-compatible', streaming: true, responseStatus: 200 }),
            streamText(
                'data: {"choices":[{"delta":{"reasoning_content":"think"}}]}\n\n',
                'data: {"choices":[{"delta":{"content":"answer"}}]}\n\n',
                'data: {"choices":[],"usage":{"completion_tokens":9}}\n\n',
                'data: [DONE]\n\n',
            ),
            onContent,
            onProgress,
        )

        expect(content).toBe('<Thoughts>\nthink\n</Thoughts>\n\nanswer')
        expect(onContent).toHaveBeenLastCalledWith(content)
        expect(onProgress).toHaveBeenLastCalledWith({
            thinking: 'think',
            response: 'answer',
            usage: { completionTokens: 9 },
        })
    })

    it('decodes a non-streaming Anthropic journal', async () => {
        const onProgress = vi.fn()
        const content = await decodeRevenantGenerationJournal(
            job({ adapterKind: 'anthropic-messages', streaming: false, responseStatus: 200 }),
            streamText(JSON.stringify({
                content: [{ type: 'text', text: 'hello' }],
                stop_reason: 'end_turn',
                usage: { input_tokens: 3, output_tokens: 1 },
            })),
            undefined,
            onProgress,
        )

        expect(content).toBe('hello')
        expect(onProgress).toHaveBeenCalledWith({
            thinking: '',
            response: 'hello',
            usage: {
                promptTokens: 3,
                completionTokens: 1,
                totalTokens: 4,
            },
        })
    })

    it('does not materialize a non-2xx provider response as assistant text', async () => {
        await expect(decodeRevenantGenerationJournal(
            job({ adapterKind: 'openai-compatible', streaming: false, responseStatus: 429 }),
            streamText('{"error":{"message":"rate limited"}}'),
        )).rejects.toThrow('HTTP 429')
    })

    it('salvages complete events before a truncated partial tail', async () => {
        const content = await decodeRevenantGenerationJournal(
            job({
                adapterKind: 'openai-compatible',
                streaming: true,
                responseStatus: 200,
                status: 'failed_partial',
            }),
            streamText(
                'data: {"choices":[{"delta":{"content":"kept"}}]}\n\n',
                'data: {"choices":[{"delta":{"content":"cut',
            ),
        )

        expect(content).toBe('kept')
    })
})
