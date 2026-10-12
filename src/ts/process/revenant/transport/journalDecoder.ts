import {
    parseAmazonBedrockResponse,
    parseAmazonBedrockStreamEvent,
    parseAwsEventStream,
} from '../../../preset/adapter/amazonBedrock'
import {
    parseAnthropicMessage,
    parseAnthropicStreamDelta,
} from '../../../preset/adapter/anthropicMessages'
import {
    parseGeminiResponse,
    parseGeminiStreamDelta,
} from '../../../preset/adapter/googleGemini'
import {
    parseRecoveredChatCompletion,
    parseRecoveredChatStreamDelta,
} from '../../../preset/adapter/openaiCompatible'
import {
    parseResponsesResponse,
    parseResponsesStreamEvent,
} from '../../../preset/adapter/openaiResponses'
import { parseSseStream } from '../../../preset/adapter/sse'
import { createThoughtSignatureCollector, supportsThoughtSignatures, type ThoughtSignatureContext } from '../../../preset/adapter/thoughtSignatures'
import type {
    AdapterChatResponse,
    AdapterChatStreamDelta,
    AdapterReasoningPart,
    AdapterUsage,
} from '../../../preset/adapter/types'
import type {
    RecoverableAuxiliaryJob,
    RecoverableGenerationJob,
} from '../types'

type RecoverableJournalJob = RecoverableGenerationJob | RecoverableAuxiliaryJob

export interface RevenantJournalProgress {
    thinking: string
    response: string
    usage?: AdapterUsage
    awaitingProviderResult?: boolean
}

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

function statusReasoning(reasoning?: AdapterReasoningPart[]): string {
    if (!reasoning?.length) return ''
    return reasoning.map(part => part.text ?? '').join('')
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
    onRaw?: (raw: unknown) => void,
): AdapterChatStreamDelta | null | undefined {
    if (event.data.length === 0 || event.data === '[DONE]') return null
    if (kind === 'anthropic-messages') {
        if (event.event === 'ping' || event.event === 'message_stop') return null
        if (event.event === 'error') throw new Error('Anthropic journal contains a stream error')
    }
    const raw: unknown = JSON.parse(event.data)
    onRaw?.(raw)
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
    onProgress?: (progress: RevenantJournalProgress) => void,
    onThoughtContext?: (context: ThoughtSignatureContext) => void,
): Promise<string> {
    const signatures = onThoughtContext && supportsThoughtSignatures(job.adapterKind ?? '')
        ? createThoughtSignatureCollector(job.adapterKind!) : undefined
    const finish = () => {
        const context = signatures?.finish()
        if (context) onThoughtContext?.(context)
    }
    if (job.responseStatus !== undefined
        && (job.responseStatus < 200 || job.responseStatus >= 300)) {
        throw new Error(`Provider request failed with HTTP ${job.responseStatus}`)
    }

    if (job.projection?.source === 'provider') {
        await stream.cancel()
        const content = projectedContent(job)
        onContent?.(content)
        onProgress?.({ thinking: '', response: content })
        return content
    }

    if (!isStreamingJournal(job)) {
        const text = await new Response(stream).text()
        if (!text.trim()) return projectedContent(job)
        const raw: unknown = JSON.parse(text)
        const parsed = parseJsonResponse(job.adapterKind, raw)
        signatures?.add(raw)
        onProgress?.({
            thinking: statusReasoning(parsed.reasoning),
            response: parsed.text,
            ...(parsed.usage ? { usage: parsed.usage } : {}),
            ...(parsed.toolCalls?.length || parsed.finishReason === 'tool_calls'
                ? { awaitingProviderResult: true } : {}),
        })
        const content = formatReasoning(parsed.reasoning) + parsed.text
        finish()
        if (content) onContent?.(content)
        return content || projectedContent(job)
    }

    let output = ''
    let reasoning = ''
    let usage: AdapterUsage | undefined
    let awaitingProviderResult = false
    const publish = () => {
        onProgress?.({
            thinking: reasoning,
            response: output,
            ...(usage ? { usage } : {}),
            ...(awaitingProviderResult ? { awaitingProviderResult: true } : {}),
        })
        const content = (reasoning ? formatReasoning([{ text: reasoning }]) : '') + output
        if (content) onContent?.(content)
        return content
    }
    const appendDelta = (delta: AdapterChatStreamDelta) => {
        output += delta.textDelta
        if (delta.reasoningDelta) reasoning += delta.reasoningDelta
        if (delta.usage) usage = delta.usage
        if (delta.finishReason === 'tool_calls' || delta.finishReason === 'tool_use') awaitingProviderResult = true
        publish()
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
            appendDelta(delta)
        }
    } else {
        for await (const event of parseSseStream(stream)) {
            let delta: AdapterChatStreamDelta | null | undefined
            try {
                delta = parseSseDelta(job.adapterKind, event, signatures?.add)
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
            appendDelta(delta)
        }
    }

    finish()
    return publish() || projectedContent(job)
}
