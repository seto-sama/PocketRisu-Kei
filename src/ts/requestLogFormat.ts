import { parseSseEventBlock } from './preset/adapter/sse'
import type { FetchLog } from './requestLogStore'

const COLLAPSIBLE_RESPONSE_EVENTS = new Set([
    'response.created',
    'response.in_progress',
    'response.content_part.added',
    'response.output_text.delta',
    'response.output_text.done',
    'response.content_part.done',
    'response.output_item.added',
    'response.output_item.done',
])

export interface ResponseBodyDetails {
    groups: Array<{
        event: string
        summary: string
        readable: string
        raw: string
    }>
    remainder: string
    rawRemainder: string
}

export function formatResponseBody(log: Pick<FetchLog, 'response' | 'url' | 'body'>): string {
    const chatCompletion = buildChatCompletionFromSse(log.response, log)
    if (chatCompletion) return formatReadableValue(chatCompletion, 0)
    try {
        return formatReadableValue(JSON.parse(log.response), 0)
    } catch {
        return log.response
    }
}

export function formatRequestBody(body: string): string {
    try {
        return formatReadableValue(JSON.parse(body), 0)
    } catch {
        return body
    }
}

export function getResponseBodyDetails(
    log: Pick<FetchLog, 'response' | 'url' | 'body'>,
): ResponseBodyDetails | null {
    const formatted = formatResponseBody(log)
    if (formatted !== log.response) return null

    const detailBlocks = new Map<string, string[]>()
    const remainderBlocks: string[] = []
    for (const block of log.response.split(/\r\n\r\n|\n\n|\r\r/)) {
        const trimmed = block.trim()
        if (!trimmed) continue
        const event = parseSseEventBlock(trimmed)
        let dataType: string | undefined
        try {
            const data = event?.data ? JSON.parse(event.data) : null
            if (typeof data?.type === 'string') dataType = data.type
        } catch {}

        const eventType = event?.event && COLLAPSIBLE_RESPONSE_EVENTS.has(event.event)
            ? event.event
            : dataType && COLLAPSIBLE_RESPONSE_EVENTS.has(dataType)
                ? dataType
                : null
        if (eventType) {
            const blocks = detailBlocks.get(eventType) ?? []
            blocks.push(trimmed)
            detailBlocks.set(eventType, blocks)
        } else {
            remainderBlocks.push(trimmed)
        }
    }

    if (detailBlocks.size === 0) return null
    return {
        groups: Array.from(detailBlocks, ([event, blocks]) => ({
            event,
            summary: `${event} × ${blocks.length}`,
            readable: formatReadableSseBlocks(blocks, false),
            raw: blocks.join('\n\n'),
        })),
        remainder: formatReadableSseBlocks(remainderBlocks, true),
        rawRemainder: remainderBlocks.join('\n\n'),
    }
}

function formatReadableSseBlocks(blocks: string[], showEventName: boolean): string {
    const parsedBlocks = blocks.map(block => {
        const event = parseSseEventBlock(block)
        if (!event) return { event: undefined, data: undefined, raw: block }
        try {
            return {
                event: event.event,
                data: event.data ? JSON.parse(event.data) : null,
                raw: block,
            }
        } catch {
            return { event: event.event, data: undefined, raw: block }
        }
    })

    // Delta fragments are most useful as the reconstructed text they produced.
    if (
        !showEventName
        && parsedBlocks.length > 0
        && parsedBlocks.every(block => typeof block.data?.delta === 'string')
    ) {
        return parsedBlocks.map(block => block.data.delta).join('')
    }

    return parsedBlocks.map(block => {
        const content = block.data === undefined
            ? block.raw
            : formatReadableEventData(block.data)
        return showEventName && block.event
            ? `event: ${block.event}\n\n${content}`
            : content
    }).join('\n\n---\n\n')
}

function formatReadableEventData(data: any): string {
    return formatReadableValue(data, 0)
}

function formatReadableValue(value: any, depth: number): string {
    if (typeof value === 'string') return formatReadableString(value, depth)
    if (value === null || typeof value !== 'object') {
        return JSON.stringify(value)
    }

    const indent = '  '.repeat(depth)
    const childIndent = '  '.repeat(depth + 1)
    if (Array.isArray(value)) {
        if (value.length === 0) return '[]'
        return `[\n${value
            .map(item => `${childIndent}${formatReadableValue(item, depth + 1)}`)
            .join(',\n')}\n${indent}]`
    }

    const entries = Object.entries(value)
    if (entries.length === 0) return '{}'
    return `{\n${entries
        .map(([key, item]) => `${childIndent}${JSON.stringify(key)}: ${formatReadableValue(item, depth + 1)}`)
        .join(',\n')}\n${indent}}`
}

function formatReadableString(value: string, depth: number): string {
    const normalized = value.replace(/\r\n|\r/g, '\n')
    if (!/[\n\t"\\]/.test(normalized)) return JSON.stringify(normalized)

    const contentIndent = '  '.repeat(depth + 1)
    return `|\n${normalized
        .split('\n')
        .map(line => `${contentIndent}${line}`)
        .join('\n')}`
}

function buildChatCompletionFromSse(response: string, log: Pick<FetchLog, 'url' | 'body'>): any | null {
    const chunks = parseSseJsonChunks(response)
    if (chunks.length === 0) return null
    const isChatCompletionStream = chunks.every(chunk => chunk?.object === 'chat.completion.chunk')
        || (isChatCompletionLog(log) && chunks.every(chunk => Array.isArray(chunk?.choices)))
    if (!isChatCompletionStream) return null

    const first = chunks[0]
    const choices = new Map<number, {
        index: number
        role?: string
        content: string
        reasoningContent: string
        toolCalls: any[]
        finishReason: string | null
    }>()
    let usage: any

    for (const chunk of chunks) {
        if (chunk.usage) usage = chunk.usage
        for (const choice of chunk.choices ?? []) {
            const index = Number.isInteger(choice.index) ? choice.index : 0
            const item = choices.get(index) ?? {
                index,
                role: undefined,
                content: '',
                reasoningContent: '',
                toolCalls: [],
                finishReason: null,
            }
            const delta = choice.delta ?? {}
            if (typeof delta.role === 'string') item.role = delta.role
            if (typeof delta.content === 'string') item.content += delta.content
            if (typeof delta.reasoning_content === 'string') item.reasoningContent += delta.reasoning_content
            if (typeof delta.reasoning === 'string') item.reasoningContent += delta.reasoning
            if (Array.isArray(delta.tool_calls)) mergeStreamingToolCalls(item.toolCalls, delta.tool_calls)
            if (choice.finish_reason !== undefined) item.finishReason = choice.finish_reason
            choices.set(index, item)
        }
    }

    return {
        id: first.id,
        object: 'chat.completion',
        created: first.created,
        model: first.model,
        choices: Array.from(choices.values()).sort((a, b) => a.index - b.index).map(choice => {
            const message: any = {
                role: choice.role ?? 'assistant',
                content: choice.content,
            }
            if (choice.reasoningContent) message.reasoning_content = choice.reasoningContent
            if (choice.toolCalls.length > 0) message.tool_calls = choice.toolCalls
            return {
                index: choice.index,
                message,
                finish_reason: choice.finishReason,
            }
        }),
        ...(usage ? { usage } : {}),
    }
}

function parseSseJsonChunks(response: string): any[] {
    const chunks: any[] = []
    for (const block of response.split(/\r\n\r\n|\n\n|\r\r/)) {
        const event = parseSseEventBlock(block)
        const data = event?.data.trim() ?? ''
        if (!data || data === '[DONE]') continue
        try {
            chunks.push(JSON.parse(data))
        } catch {
            // Server-side request logs may be byte-truncated in the middle of a
            // final SSE event. Keep the complete chunks we already parsed so
            // display/copy can still show the assembled partial response.
            if (chunks.length === 0) return []
        }
    }
    return chunks
}

function isChatCompletionLog(log: Pick<FetchLog, 'url' | 'body'>): boolean {
    try {
        if (new URL(log.url).pathname.includes('/chat/completions')) return true
    } catch {}

    try {
        return Array.isArray(JSON.parse(log.body)?.messages)
    } catch {
        return false
    }
}

function mergeStreamingToolCalls(target: any[], incoming: any[]) {
    for (const toolCall of incoming) {
        const index = Number.isInteger(toolCall.index) ? toolCall.index : target.length
        const existing = target[index] ?? {
            id: undefined,
            type: 'function',
            function: { name: '', arguments: '' },
        }
        if (toolCall.id) existing.id = toolCall.id
        if (toolCall.type) existing.type = toolCall.type
        if (toolCall.function?.name) existing.function.name += toolCall.function.name
        if (toolCall.function?.arguments) existing.function.arguments += toolCall.function.arguments
        target[index] = existing
    }
}
