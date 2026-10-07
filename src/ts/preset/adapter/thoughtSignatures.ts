import { extractThinkTags } from '../thinkingTags'
import type { GeminiPart } from './googleGemini'
import type { AdapterChatMessage, AdapterToolCall } from './types'

type ToolSignature = Pick<AdapterToolCall, 'id' | 'name' | 'signature'>

export interface ThoughtSignatureContext {
    geminiParts?: GeminiPart[]
    textPartIndex?: number
    extraContent?: Record<string, unknown>
    reasoningDetails?: Record<string, unknown>[]
    toolCalls?: ToolSignature[]
}

export interface ProviderContextRecord {
    responseId: string
    adapterKind: string
    model: string
    turns: ThoughtSignatureContext[]
}

function object(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function googleSignature(value: unknown): boolean {
    return object(value) && object(value.google)
        && typeof value.google.thought_signature === 'string'
        && value.google.thought_signature.length > 0
}

export function supportsThoughtSignatures(adapterKind: string): boolean {
    return adapterKind === 'google-gemini' || adapterKind === 'openai-compatible'
}

/** Collects opaque Gemini context from either a JSON response or SSE events. */
export function createThoughtSignatureCollector(adapterKind: string) {
    const parts: GeminiPart[] = []
    const toolCalls = new Map<number, ToolSignature>()
    const details: Record<string, unknown>[] = []
    let textPartIndex: number | undefined
    let extraContent: Record<string, unknown> | undefined

    return {
        add(raw: unknown) {
            if (!object(raw)) return
            if (adapterKind === 'google-gemini') {
                const candidate = Array.isArray(raw.candidates) ? raw.candidates[0] : undefined
                const content = object(candidate) ? candidate.content : undefined
                if (!object(content) || !Array.isArray(content.parts)) return
                for (const part of content.parts) {
                    if (!object(part)) continue
                    if (typeof part.thoughtSignature === 'string' || object(part.functionCall)) {
                        const saved = structuredClone(part) as GeminiPart
                        // Visible output comes from the current message, including edits.
                        if (typeof saved.text === 'string' && !saved.thought) {
                            if (saved.text && textPartIndex === undefined) textPartIndex = parts.length
                            saved.text = ''
                        }
                        parts.push(saved)
                    }
                }
                return
            }
            if (adapterKind !== 'openai-compatible') return
            const choice = Array.isArray(raw.choices) ? raw.choices[0] : undefined
            if (!object(choice)) return
            const delta = object(choice.message) ? choice.message : choice.delta
            if (!object(delta)) return
            if (googleSignature(delta.extra_content)) extraContent = structuredClone(delta.extra_content) as Record<string, unknown>
            if (Array.isArray(delta.reasoning_details)) {
                for (const detail of delta.reasoning_details) {
                    if (!object(detail) || detail.format !== 'google-gemini-v1') continue
                    details.push(structuredClone(detail))
                }
            }
            if (!Array.isArray(delta.tool_calls)) return
            for (const [position, entry] of delta.tool_calls.entries()) {
                if (!object(entry)) continue
                const index = typeof entry.index === 'number' ? entry.index : position
                const call = toolCalls.get(index) ?? { id: '', name: '' }
                if (typeof entry.id === 'string') call.id = entry.id
                if (object(entry.function)) {
                    if (typeof entry.function.name === 'string') call.name = entry.function.name
                }
                if (googleSignature(entry.extra_content)) {
                    const google = (entry.extra_content as { google: { thought_signature?: string } }).google
                    call.signature = google.thought_signature
                }
                toolCalls.set(index, call)
            }
        },
        finish(): ThoughtSignatureContext | undefined {
            if (adapterKind === 'google-gemini') {
                if (!parts.some(part => !!part.thoughtSignature)) return
                return { geminiParts: parts, ...(textPartIndex !== undefined ? { textPartIndex } : {}) }
            }
            const calls = [...toolCalls.values()]
            if (!extraContent && details.length === 0 && !calls.some(call => !!call.signature)) return
            return {
                ...(extraContent ? { extraContent } : {}),
                ...(details.length ? { reasoningDetails: details } : {}),
                ...(calls.length ? { toolCalls: calls } : {}),
            }
        },
    }
}

function contextCalls(context: ThoughtSignatureContext): Array<{ id?: string; name: string }> {
    return context.toolCalls ?? context.geminiParts?.flatMap(part =>
        part.functionCall ? [part.functionCall] : []) ?? []
}

/** Rejoins saved parallel calls before their results and attaches context by UUID. */
export function restoreThoughtSignatures(
    messages: AdapterChatMessage[],
    records: ProviderContextRecord[],
): AdapterChatMessage[] {
    if (records.length === 0) return messages
    const byId = new Map(records.map(record => [record.responseId, record.turns]))
    const out: AdapterChatMessage[] = []
    for (let start = 0; start < messages.length;) {
        const source = messages[start]
        const turns = source.responseId ? byId.get(source.responseId) : undefined
        if (!turns || source.role !== 'assistant') {
            out.push(source)
            start++
            continue
        }
        let end = start + 1
        while (end < messages.length && messages[end].responseId === source.responseId) end++
        const outputStart = out.length
        const group = messages.slice(start, end)
        let turnIndex = 0
        for (let index = 0; index < group.length; index++) {
            const message = group[index]
            if (message.role !== 'assistant' || !message.toolCalls?.length) {
                out.push(message)
                continue
            }
            while (turnIndex < turns.length && contextCalls(turns[turnIndex]).length === 0) turnIndex++
            const context = turns[turnIndex++]
            const calls = context ? contextCalls(context) : []
            const assistants: AdapterChatMessage[] = []
            const results: AdapterChatMessage[] = []
            for (const call of calls) {
                const assistant = group[index + assistants.length * 2]
                const result = group[index + assistants.length * 2 + 1]
                const actual = assistant?.toolCalls?.[0]
                if (!actual || result?.role !== 'tool' || actual.name !== call.name
                    || (call.id && call.id !== actual.id)) break
                assistants.push(assistant)
                results.push(result)
            }
            if (assistants.length !== calls.length || assistants.length === 0) {
                out.push(message)
                continue
            }
            out.push({
                ...message,
                content: assistants.map(assistant => assistant.content).join(''),
                toolCalls: assistants.flatMap((assistant, index) => (assistant.toolCalls ?? []).map(call => ({
                    ...call,
                    ...(context?.toolCalls?.[index]?.signature
                        ? { signature: context.toolCalls[index].signature } : {}),
                }))),
                thoughtContext: context,
            }, ...results)
            index += assistants.length * 2 - 1
        }
        const finalContext = turns.findLast(turn => contextCalls(turn).length === 0)
        if (finalContext) {
            for (let index = out.length - 1; index >= outputStart; index--) {
                const message = out[index]
                if (message.role !== 'assistant' || message.toolCalls?.length) continue
                out[index] = { ...message, thoughtContext: finalContext }
                break
            }
        }
        start = end
    }
    return out
}

export function restoreGeminiParts(
    message: AdapterChatMessage,
    parseToolArgs: (args: string) => unknown,
): GeminiPart[] | undefined {
    const saved = message.thoughtContext?.geminiParts
    if (!saved?.length) return
    const parts = structuredClone(saved)
    const content = saved.some(part => part.thought)
        ? extractThinkTags(message.content, 'Thoughts').text.trimStart() : message.content
    let textPlaced = false
    let callIndex = 0
    const retained: GeminiPart[] = []
    for (const [index, part] of parts.entries()) {
        if (part.functionCall) {
            const call = message.toolCalls?.[callIndex++]
            if (!call) continue
            part.functionCall = {
                ...(call.id ? { id: call.id } : {}),
                name: call.name,
                args: parseToolArgs(call.arguments),
            }
        } else if (index === message.thoughtContext?.textPartIndex) {
            part.text = content
            textPlaced = true
        }
        retained.push(part)
    }
    if (!textPlaced && content) {
        const index = retained.findIndex(part => !part.thought)
        retained.splice(index < 0 ? retained.length : index, 0, { text: content })
    }
    return retained
}
