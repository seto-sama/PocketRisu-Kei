import {
    parseAmazonBedrockResponse,
    parseAmazonBedrockStreamEvent,
    parseAwsEventStream,
} from '../../preset/adapter/amazonBedrock'
import {
    parseAnthropicMessage,
    parseAnthropicStreamDelta,
} from '../../preset/adapter/anthropicMessages'
import {
    parseGeminiResponse,
    parseGeminiStreamDelta,
} from '../../preset/adapter/googleGemini'
import {
    parseRecoveredChatCompletion,
    parseRecoveredChatStreamDelta,
} from '../../preset/adapter/openaiCompatible'
import {
    parseResponsesResponse,
    parseResponsesStreamEvent,
} from '../../preset/adapter/openaiResponses'
import { parseSseStream } from '../../preset/adapter/sse'
import type {
    AdapterChatResponse,
    AdapterChatStreamDelta,
    AdapterReasoningPart,
} from '../../preset/adapter/types'
import type {
    RecoverableAuxiliaryJob,
    RecoverableGenerationJob,
} from './types'

type RecoverableJournalJob = RecoverableGenerationJob | RecoverableAuxiliaryJob

function projectedContent(job: RecoverableJournalJob): string {
    return job.projection?.content ?? ''
}

function formatReasoning(reasoning?: AdapterReasoningPart[]): string {
    if (!reasoning?.length) return ''
    let body = ''
    for (const part of reasoning) {
        if (part.redactedData !== undefined) body += '\n{{redacted_thinking}}\n'
        else if (part.text) body += part.text
    }
    return body.trim().length > 0 ? `<Thoughts>\n${body}\n</Thoughts>\n\n` : ''
}

function parseJsonResponse(kind: string | undefined, raw: unknown): AdapterChatResponse {
    switch (kind) {
        case 'anthropic-messages': return parseAnthropicMessage(raw)
        case 'google-gemini': return parseGeminiResponse(raw)
        case 'openai-responses': return parseResponsesResponse(raw)
        case 'amazon-bedrock': return parseAmazonBedrockResponse(raw)
        default: return parseRecoveredChatCompletion(raw)
    }
}

function parseSseDelta(
    kind: string | undefined,
    event: { event?: string, data: string },
): AdapterChatStreamDelta | null | undefined {
    if (event.data.length === 0 || event.data === '[DONE]') return null
    if (kind === 'anthropic-messages') {
        if (event.event === 'ping' || event.event === 'message_stop') return null
        if (event.event === 'error') throw new Error('Anthropic journal contains a stream error')
    }
    const raw: unknown = JSON.parse(event.data)
    switch (kind) {
        case 'anthropic-messages': return parseAnthropicStreamDelta(event.event, raw)
        case 'google-gemini': return parseGeminiStreamDelta(raw)
        case 'openai-responses': return parseResponsesStreamEvent(raw)
        default: return parseRecoveredChatStreamDelta(raw)
    }
}

function contentType(job: RecoverableJournalJob): string {
    const headers = job.responseHeaders ?? {}
    return headers['content-type'] ?? headers['Content-Type'] ?? ''
}

function isStreamingJournal(job: RecoverableJournalJob): boolean {
    return job.streaming === true || contentType(job).includes('text/event-stream')
}

export async function decodeRevenantGenerationJournal(
    job: RecoverableJournalJob,
    stream: ReadableStream<Uint8Array>,
    onContent?: (content: string) => void,
): Promise<string> {
    if (job.responseStatus !== undefined
        && (job.responseStatus < 200 || job.responseStatus >= 300)) {
        throw new Error(`Provider request failed with HTTP ${job.responseStatus}`)
    }

    if (!isStreamingJournal(job)) {
        const text = await new Response(stream).text()
        if (!text.trim()) return projectedContent(job)
        const parsed = parseJsonResponse(job.adapterKind, JSON.parse(text))
        const content = formatReasoning(parsed.reasoning) + parsed.text
        if (content) onContent?.(content)
        return content || projectedContent(job)
    }

    let output = ''
    let reasoning = ''
    const publish = () => {
        const content = (reasoning ? formatReasoning([{ text: reasoning }]) : '') + output
        if (content) onContent?.(content)
        return content
    }

    if (job.adapterKind === 'amazon-bedrock') {
        for await (const message of parseAwsEventStream(stream)) {
            const messageType = message.headers[':message-type']
            if (messageType === 'exception' || messageType === 'error') {
                throw new Error('Amazon Bedrock journal contains a stream error')
            }
            const raw = JSON.parse(new TextDecoder().decode(message.payload))
            const delta = parseAmazonBedrockStreamEvent(message.headers[':event-type'], raw)
            if (!delta) continue
            output += delta.textDelta
            if (delta.reasoningDelta) reasoning += delta.reasoningDelta
            publish()
        }
    } else {
        for await (const event of parseSseStream(stream)) {
            let delta: AdapterChatStreamDelta | null | undefined
            try {
                delta = parseSseDelta(job.adapterKind, event)
            }
            catch (error) {
                if (
                    job.status === 'interrupted'
                    || job.status === 'failed_partial'
                    || job.status === 'cancelled'
                ) continue
                throw error
            }
            if (!delta) continue
            output += delta.textDelta
            if (delta.reasoningDelta) reasoning += delta.reasoningDelta
            publish()
        }
    }

    return publish() || projectedContent(job)
}
