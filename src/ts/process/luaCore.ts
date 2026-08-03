export type LuaCoreMessage = {
    role?: string
    data?: string
    time?: number
}

export type LuaCoreChat = {
    message: LuaCoreMessage[]
    note?: string
}

export type LuaCoreCharacter = {
    name?: string
    desc?: string
    firstMessage?: string
    backgroundHTML?: string
}

export type LuaCoreAdapter = {
    canSetVariable: (accessKey: string) => boolean
    canMutate: (accessKey: string) => boolean
    getChat: () => LuaCoreChat
    getCharacter: () => LuaCoreCharacter
    getVar: (key: string) => string
    setVar: (key: string, value: string) => void
    getGlobalVar: (key: string) => string
    stop: () => void
    render: (value: string) => string
    markCharacterMutation?: (field: keyof LuaCoreCharacter, value: string) => void
}

export type LuaApiDeclarer = (name: string, handler: (...args: any[]) => unknown) => void

export const LUA_EFFECT_API_POLICIES = {
    alertError: 'safe',
    alertNormal: 'safe',
    alertInput: 'safe',
    alertSelect: 'safe',
    alertConfirm: 'safe',
    getTokens: 'safe',
    sleep: 'safe',
    reloadDisplay: 'safe',
    reloadChat: 'safe',
    upsertLocalLoreBook: 'safe',
    similarity: 'lowLevel',
    request: 'lowLevel',
    generateImage: 'lowLevel',
    LLMMain: 'lowLevel',
    simpleLLM: 'lowLevel',
    loadLoreBooksMain: 'lowLevel',
    axLLMMain: 'lowLevel',
    logMain: 'public',
    getCharacterImageMain: 'public',
    getPersonaImageMain: 'public',
    hash: 'public',
    getPersonaName: 'public',
    getPersonaDescription: 'public',
    getLoreBooksMain: 'public',
} as const

export type LuaEffectApiName = keyof typeof LUA_EFFECT_API_POLICIES

export type LuaEffectAdapter = {
    canUseSafeApi: (accessKey: string) => boolean
    canUseLowLevelApi: (accessKey: string) => boolean
    invoke: (name: LuaEffectApiName, args: unknown[]) => unknown
}

function deniedLuaEffectResult(name: LuaEffectApiName): unknown {
    const message = 'Low-level access is disabled'
    switch (name) {
        case 'LLMMain':
        case 'axLLMMain':
            return JSON.stringify({ success: false, result: message })
        case 'simpleLLM':
            return { success: false, result: message }
        case 'request':
            return JSON.stringify({ status: 403, data: message })
        case 'similarity':
            return []
        case 'generateImage':
            return ''
        case 'loadLoreBooksMain':
            return JSON.stringify([])
        default:
            return undefined
    }
}

/** Registers browser/server effect APIs through one permission boundary. */
export function registerLuaEffectApis(
    declare: LuaApiDeclarer,
    getAdapter: () => LuaEffectAdapter,
): void {
    for (const [name, permission] of Object.entries(LUA_EFFECT_API_POLICIES) as [LuaEffectApiName, string][]) {
        declare(name, (...args: unknown[]) => {
            const adapter = getAdapter()
            const accessKey = String(args[0] ?? '')
            const allowed = permission === 'public'
                || (permission === 'safe' && adapter.canUseSafeApi(accessKey))
                || (permission === 'lowLevel' && adapter.canUseLowLevelApi(accessKey))
            return allowed ? adapter.invoke(name, args) : deniedLuaEffectResult(name)
        })
    }
}

function normalizeRole(role: unknown): 'user' | 'char' {
    return role === 'user' ? 'user' : 'char'
}

/**
 * Registers APIs whose behavior is independent of browser/server facilities.
 * The adapter is looked up for every call so cached Lua engines never retain a
 * previous invocation's chat, character, permission, or stop flag.
 */
export function registerLuaCoreApis(
    declare: LuaApiDeclarer,
    getAdapter: () => LuaCoreAdapter,
): void {
    declare('getChatVar', (_accessKey, key) => getAdapter().getVar(String(key)))
    declare('setChatVar', (accessKey, key, value) => {
        const adapter = getAdapter()
        if (adapter.canSetVariable(String(accessKey))) {
            adapter.setVar(String(key), String(value ?? 'null'))
        }
    })
    declare('getGlobalVar', (_accessKey, key) => getAdapter().getGlobalVar(String(key)))
    declare('stopChat', accessKey => {
        const adapter = getAdapter()
        if (adapter.canMutate(String(accessKey))) adapter.stop()
    })
    declare('getChatMain', (_accessKey, index) => {
        const message = getAdapter().getChat().message.at(Number(index))
        return JSON.stringify(message ? {
            role: message.role,
            data: message.data,
            time: message.time ?? 0,
        } : null)
    })
    declare('setChat', (accessKey, index, value) => {
        const adapter = getAdapter()
        if (!adapter.canMutate(String(accessKey))) return
        const message = adapter.getChat().message.at(Number(index))
        if (message) message.data = String(value ?? '')
    })
    declare('setChatRole', (accessKey, index, role) => {
        const adapter = getAdapter()
        if (!adapter.canMutate(String(accessKey))) return
        const message = adapter.getChat().message.at(Number(index))
        if (message) message.role = normalizeRole(role)
    })
    declare('cutChat', (accessKey, start, end) => {
        const adapter = getAdapter()
        if (!adapter.canMutate(String(accessKey))) return
        const chat = adapter.getChat()
        chat.message = chat.message.slice(Number(start), Number(end))
    })
    declare('removeChat', (accessKey, index) => {
        const adapter = getAdapter()
        if (adapter.canMutate(String(accessKey))) {
            adapter.getChat().message.splice(Number(index), 1)
        }
    })
    declare('addChat', (accessKey, role, value) => {
        const adapter = getAdapter()
        if (adapter.canMutate(String(accessKey))) {
            adapter.getChat().message.push({ role: normalizeRole(role), data: String(value ?? '') })
        }
    })
    declare('insertChat', (accessKey, index, role, value) => {
        const adapter = getAdapter()
        if (adapter.canMutate(String(accessKey))) {
            adapter.getChat().message.splice(Number(index), 0, {
                role: normalizeRole(role),
                data: String(value ?? ''),
            })
        }
    })
    declare('getChatLength', () => getAdapter().getChat().message.length)
    declare('getFullChatMain', () => JSON.stringify(getAdapter().getChat().message.map(message => ({
        role: message.role,
        data: message.data,
        time: message.time ?? 0,
    }))))
    declare('setFullChatMain', (accessKey, value) => {
        const adapter = getAdapter()
        if (!adapter.canMutate(String(accessKey))) return
        const parsed = JSON.parse(String(value))
        if (!Array.isArray(parsed)) return
        adapter.getChat().message = parsed.map(message => ({
            role: normalizeRole(message?.role),
            data: String(message?.data ?? ''),
            time: message?.time,
        }))
    })
    declare('cbs', value => getAdapter().render(String(value ?? '')))

    declare('getName', () => getAdapter().getCharacter().name ?? '')
    declare('setName', (accessKey, value) => {
        const adapter = getAdapter()
        if (!adapter.canMutate(String(accessKey))) return
        const normalized = String(value)
        adapter.getCharacter().name = normalized
        adapter.markCharacterMutation?.('name', normalized)
    })
    declare('getDescription', accessKey => {
        const adapter = getAdapter()
        return adapter.canMutate(String(accessKey)) ? adapter.getCharacter().desc ?? '' : undefined
    })
    declare('setDescription', (accessKey, value) => {
        const adapter = getAdapter()
        if (!adapter.canMutate(String(accessKey))) return
        const normalized = String(value)
        adapter.getCharacter().desc = normalized
        adapter.markCharacterMutation?.('desc', normalized)
    })
    declare('getCharacterFirstMessage', () => getAdapter().getCharacter().firstMessage ?? '')
    declare('setCharacterFirstMessage', (accessKey, value) => {
        const adapter = getAdapter()
        if (!adapter.canMutate(String(accessKey)) || typeof value !== 'string') return false
        adapter.getCharacter().firstMessage = value
        adapter.markCharacterMutation?.('firstMessage', value)
        return true
    })
    declare('getCharacterLastMessage', () => {
        const adapter = getAdapter()
        return adapter.getChat().message.findLast(message => message.role === 'char')?.data
            ?? adapter.getCharacter().firstMessage
            ?? ''
    })
    declare('getUserLastMessage', () => (
        getAdapter().getChat().message.findLast(message => message.role === 'user')?.data ?? ''
    ))
    declare('getAuthorsNote', () => getAdapter().getChat().note ?? '')
    declare('getBackgroundEmbedding', accessKey => {
        const adapter = getAdapter()
        return adapter.canMutate(String(accessKey))
            ? adapter.getCharacter().backgroundHTML ?? ''
            : undefined
    })
    declare('setBackgroundEmbedding', (accessKey, value) => {
        const adapter = getAdapter()
        if (!adapter.canMutate(String(accessKey)) || typeof value !== 'string') return false
        adapter.getCharacter().backgroundHTML = value
        adapter.markCharacterMutation?.('backgroundHTML', value)
        return true
    })
}

type LuaGlobal = {
    get: (name: string) => ((...args: any[]) => unknown) | undefined
}

export async function invokeLuaMode(
    global: LuaGlobal,
    mode: string,
    accessKey: string,
    data: unknown,
    meta: unknown,
): Promise<{ result: unknown, data: unknown }> {
    if (['editRequest', 'editDisplay', 'editInput', 'editOutput'].includes(mode)) {
        const listener = global.get('callListenMain')
        if (!listener) return { result: undefined, data }
        const result = await listener(mode, accessKey, JSON.stringify(data), JSON.stringify(meta))
        const nextData = JSON.parse(String(result))
        return { result: nextData, data: nextData }
    }

    const callbackName = mode === 'input' ? 'onInput'
        : mode === 'output' ? 'onOutput'
            : mode === 'start' ? 'onStart'
                : mode
    const callback = global.get(callbackName)
    if (!callback) return { result: undefined, data }
    const result = mode === 'onButtonClick'
        ? await callback(accessKey, data)
        : await callback(accessKey)
    return { result, data }
}
