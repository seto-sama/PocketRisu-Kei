import type {
    AdapterChatMessage,
    AdapterImagePart,
    AdapterMediaPart,
} from 'src/ts/preset/adapter'
import { extractThinkTags } from '../../preset/thinkingTags'
import type { OpenAIChat } from '../index.svelte'
import type { toolCallData } from '../mcp/mcp'
import type { RPCToolCallContent } from '../mcp/mcplib'

// Inject tool decoding to avoid importing the MCP and database runtime here.
export type DecodeToolCall = (text: string) => Promise<toolCallData | undefined>

export function getPromptResponseId(message: OpenAIChat): string | undefined {
    return message.responseId ?? message.memo
}

// Expand saved tool markers into assistant calls and their results.
export async function expandAdapterMessages(
    formated: OpenAIChat[],
    decode: DecodeToolCall,
    includeImages = false,
    includeReasoning = false,
    includeAudio = false,
    includeVideo = false,
): Promise<AdapterChatMessage[]> {
    const out: AdapterChatMessage[] = []
    for (let index = 0; index < formated.length; index++) {
        const m = formated[index]
        if (m.role === 'assistant' && typeof m.content === 'string' && m.content.includes('<tool_call>')) {
            out.push(...await expandToolCallMessage(m, decode))
            continue
        }
        out.push(toAdapterMessage(
            m,
            includeImages,
            includeReasoning && index === formated.length - 1,
            includeAudio,
            includeVideo,
        ))
    }
    return out
}

function parseImageData(src: string): AdapterImagePart {
    const match = /^data:([^;]+);base64,(.*)$/s.exec(src)
    if (match) return { kind: 'image', base64: match[2], mime: match[1] }
    return { kind: 'image', base64: src }
}

function parseMediaData(
    src: string,
    kind: AdapterMediaPart['kind'],
): AdapterMediaPart {
    const match = /^data:([^;]+);base64,(.*)$/s.exec(src)
    if (match) return { kind, base64: match[2], mime: match[1] }
    return { kind, base64: src }
}

function extractImages(m: OpenAIChat): AdapterImagePart[] | undefined {
    if (!m.multimodals || m.multimodals.length === 0) return undefined
    const images: AdapterImagePart[] = []
    for (const mm of m.multimodals) {
        if (mm.type === 'image' && typeof mm.base64 === 'string' && mm.base64.length > 0) {
            images.push(parseImageData(mm.base64))
        }
    }
    return images.length > 0 ? images : undefined
}

function extractMedia(
    m: OpenAIChat,
    includeAudio: boolean,
    includeVideo: boolean,
): AdapterMediaPart[] | undefined {
    if (!m.multimodals || m.multimodals.length === 0) return undefined
    const media: AdapterMediaPart[] = []
    for (const mm of m.multimodals) {
        if (
            typeof mm.base64 !== 'string'
            || mm.base64.length === 0
            || (mm.type === 'audio' && !includeAudio)
            || (mm.type === 'video' && !includeVideo)
        ) {
            continue
        }
        if (mm.type === 'audio' || mm.type === 'video') {
            media.push(parseMediaData(mm.base64, mm.type))
        }
    }
    return media.length > 0 ? media : undefined
}

async function expandToolCallMessage(
    m: OpenAIChat,
    decode: DecodeToolCall,
): Promise<AdapterChatMessage[]> {
    const segments = (m.content ?? '').split(/(<tool_call>.*?<\/tool_call>)/gms)
    const out: AdapterChatMessage[] = []
    let pending = ''
    const responseId = getPromptResponseId(m)
    for (const segment of segments) {
        if (/^<tool_call>.*<\/tool_call>$/s.test(segment)) {
            const decoded = await decode(segment)
            if (!decoded) { pending += segment; continue }
            out.push({
                role: 'assistant',
                content: pending,
                ...(responseId ? { responseId } : {}),
                toolCalls: [{
                    id: decoded.call.id,
                    name: decoded.call.name,
                    arguments: typeof decoded.call.arg === 'string' ? decoded.call.arg : JSON.stringify(decoded.call.arg),
                }],
            })
            out.push({
                role: 'tool',
                content: toolResponseText(decoded.response),
                ...(responseId ? { responseId } : {}),
                toolCallId: decoded.call.id,
                name: decoded.call.name,
            })
            pending = ''
        } else {
            pending += segment
        }
    }
    if (pending.trim().length > 0) {
        out.push({ role: 'assistant', content: pending, ...(responseId ? { responseId } : {}) })
    }
    // The cache boundary follows the last message produced from this turn.
    if (m.cachePoint && out.length > 0) {
        out[out.length - 1].cachePoint = true
    }
    return out
}

export function toolResponseText(response: RPCToolCallContent[]): string {
    const texts: string[] = []
    for (const c of response) {
        if (c.type === 'text') texts.push(c.text)
    }
    return texts.join('\n')
}

export function toAdapterMessage(
    m: OpenAIChat,
    includeImages = false,
    includeReasoning = false,
    includeAudio = false,
    includeVideo = false,
): AdapterChatMessage {
    const role: AdapterChatMessage['role'] = m.role === 'function' ? 'tool' : m.role
    const fallback = includeReasoning && role === 'assistant'
        ? extractThinkTags(m.content ?? '')
        : { text: m.content ?? '', reasoning: undefined }
    const msg: AdapterChatMessage = { role, content: fallback.text }
    const responseId = getPromptResponseId(m)
    if (role === 'assistant' && responseId) msg.responseId = responseId
    if (m.name) msg.name = m.name
    if (m.cachePoint) msg.cachePoint = true
    if (includeImages && role === 'user') {
        const images = extractImages(m)
        if (images) msg.images = images
    }
    if ((includeAudio || includeVideo) && role === 'user') {
        const media = extractMedia(m, includeAudio, includeVideo)
        if (media) msg.media = media
    }
    if (includeReasoning && role === 'assistant') {
        const thoughts = [
            ...(m.thoughts ?? []),
            ...(fallback.reasoning ? [fallback.reasoning] : []),
        ].filter((thought) => thought.length > 0)
        if (thoughts.length > 0) msg.reasoning = thoughts.map((text) => ({ text }))
    }
    return msg
}
