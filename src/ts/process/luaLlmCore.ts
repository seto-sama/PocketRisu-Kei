export type LuaLlmMessage = {
    role: 'system' | 'user' | 'assistant'
    content: string
}

export type LuaLlmResult = {
    success: boolean
    result: string
}

export function normalizeLuaLlmPrompt(value: unknown): LuaLlmMessage[] {
    const parsed = typeof value === 'string' ? JSON.parse(value) : value
    if (!Array.isArray(parsed)) throw new TypeError('Lua LLM prompt must be an array')
    return parsed.map(item => {
        const source = item && typeof item === 'object' ? item as Record<string, unknown> : {}
        const rawRole = String(source.role ?? 'assistant')
        const role = rawRole === 'system' || rawRole === 'sys' ? 'system'
            : rawRole === 'user' ? 'user'
                : 'assistant'
        return { role, content: String(source.content ?? source.data ?? '') }
    })
}

export function parseLuaLlmOptions(value: unknown): Record<string, unknown> {
    if (!value) return {}
    try {
        const parsed = typeof value === 'string' ? JSON.parse(value) : value
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
            ? parsed as Record<string, unknown>
            : {}
    }
    catch {
        return {}
    }
}

export function extractLuaLlmInlays(message: LuaLlmMessage): {
    content: string
    inlayIds: string[]
} {
    const inlayIds: string[] = []
    const content = message.content.replace(
        /{{(inlay|inlayed|inlayeddata)::(.+?)}}/g,
        (_match, kind: string, id: string) => {
            if (id && (message.role !== 'assistant' || kind === 'inlayeddata')) inlayIds.push(id)
            return ''
        },
    )
    return { content, inlayIds }
}

export function normalizeLuaLlmResult(value: unknown): LuaLlmResult {
    if (value && typeof value === 'object') {
        const source = value as { success?: unknown, result?: unknown }
        if (typeof source.success === 'boolean') {
            return { success: source.success, result: String(source.result ?? '') }
        }
    }
    return { success: true, result: String(value ?? '') }
}

export function luaLlmResult(success: boolean, result: unknown, errorPrefix = false): LuaLlmResult {
    const text = String(result ?? '')
    return { success, result: !success && errorPrefix ? `Error: ${text}` : text }
}

export function serializeLuaLlmResult(value: unknown): string {
    return JSON.stringify(normalizeLuaLlmResult(value))
}
