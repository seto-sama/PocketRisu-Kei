// @vitest-environment node
import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest'
import { writable } from 'svelte/store'

vi.mock('../parser/parser.svelte', () => ({ risuChatParser: (text: string) => text, hasher: async (data: Uint8Array) => createHash('sha256').update(data).digest('hex') }))
const state = vi.hoisted(() => ({
    db: {} as any,
    alertInput: vi.fn(),
    request: vi.fn(async (_options?: any, _mode?: string) => ({ type: 'success', result: 'client result' })),
    image: vi.fn(async () => '{{inlayed::image}}'),
    moduleLorebooks: [] as any[],
    jobs: [] as any[],
    save: vi.fn(async () => {}),
    consume: vi.fn(async (_id: string) => {}),
}))
vi.mock('../storage/database.svelte', () => ({ getDatabase: () => state.db, getCurrentChat: () => state.db.characters[0].chats[0], normalizeChat: (chat: unknown) => chat }))
vi.mock('../stores.svelte', () => ({
    DBState: { get db() { return state.db } },
    selectedCharID: writable(0), ReloadGUIPointer: writable(0),
    CurrentTriggerIdStore: writable(null),
}))
vi.mock('../alert', () => ({ alertInput: state.alertInput }))
vi.mock('../util', () => ({ parseKeyValue: (text = '') => text.split('\n').filter(Boolean).map(line => line.split('=')) }))
vi.mock('../globalApi.svelte', () => ({ requestImmediateSave: state.save }))
vi.mock('../tokenizer', () => ({}))
vi.mock('./modules', () => ({ getModuleTriggers: () => [], getModuleLorebooks: () => state.moduleLorebooks }))
vi.mock('./files/inlays', () => ({}))
vi.mock('./lorebook.svelte', () => ({}))
vi.mock('./command', () => ({ processMultiCommand: vi.fn() }))
vi.mock('./revenant', async () => import('./revenant/types'))
vi.mock('./revenant/auxiliary', () => ({
    findRecoverableAuxiliaryGeneration: async (predicate: (job: any) => boolean) => state.jobs.find(predicate),
    listRecoverableAuxiliaryGenerations: async () => state.jobs,
    resolveRecoverableAuxiliaryGenerations: async (options: any) => state.jobs.filter(job => options.isContext(job.operationContext) && options.matchesContext(job.operationContext)),
    consumeRecoverableAuxiliaryGeneration: state.consume,
}))
vi.mock('./revenant/workflow/imageWorkflow', () => ({ generateImageThroughWorkflow: state.image }))
vi.mock('./revenant/postprocess', async () => import('./revenant/postprocess/luaWrapper'))
vi.mock('./memory/hypamemory', () => ({
    HypaProcesser: class {
        async addText() {}
        async similaritySearch() { return [['second', 0.9], ['first', 0.4]] }
    },
}))
vi.mock('./request/request', () => ({
    requestChatData: state.request,
}))

beforeAll(async () => {
    const jsonLua = await readFile('public/lua/json.lua', 'utf8')
    vi.stubGlobal('fetch', async () => new Response(jsonLua))
})

afterAll(() => vi.unstubAllGlobals())

beforeEach(() => {
    state.db = { characters: [], templateDefaultVariables: '', globalChatVariables: {} }
    state.jobs = []
    state.moduleLorebooks = []
    vi.clearAllMocks()
    state.request.mockResolvedValue({ type: 'success', result: 'client result' })
    state.consume.mockImplementation(async id => { state.jobs = state.jobs.filter(job => job.jobId !== id) })
})

it('uses the originating character lore and defaults when rendering a simple projection', async () => {
    const { runScripted } = await import('./scriptings')
    const chat = { id: 'origin-chat', message: [], localLore: [{ comment: 'local', content: 'local lore' }] }
    const character = {
        type: 'character', chaId: 'origin', name: 'Origin', chats: [chat],
        defaultVariables: '__settings={"enabled":true}',
        globalLore: [{ comment: 'character', content: 'origin lore' }],
    }
    state.db.characters = [
        { type: 'character', chaId: 'other', globalLore: [{ comment: 'character', content: 'wrong lore' }] },
        character,
    ]
    state.moduleLorebooks = [{ comment: 'lightboard-prelude', content: 'module prelude' }]

    const result = await runScripted(`
        listenEdit('editDisplay', function(id, data)
            local prelude = getLoreBooks(id, 'lightboard-prelude')[1]
            local localLore = getLoreBooks(id, 'local')[1]
            local characterLore = getLoreBooks(id, 'character')[1]
            assert(getState(id, 'settings').enabled)
            return data .. ':' .. prelude.content .. ':' .. localLore.content .. ':' .. characterLore.content
        end)
    `, {
        char: { type: 'simple', chaId: 'origin', customscript: [] } as never,
        chat: chat as never,
        mode: 'editDisplay',
        data: 'display',
    })

    expect(result.res).toBe('display:module prelude:local lore:origin lore')
})

it('returns nil for missing and empty states through the browser variable adapter', async () => {
    const { runScripted } = await import('./scriptings')
    const chat = { message: [], scriptstate: { '$__empty': '' } }
    const result = await runScripted(`
        function onStart(id)
            assert(getState(id, 'missing') == nil)
            assert(getState(id, 'empty') == nil)
            return 'completed'
        end
    `, {
        char: { type: 'character', defaultVariables: '' } as never,
        chat: chat as never,
        mode: 'start',
    })

    expect(result.res).toBe('completed')
    expect(chat.scriptstate).toEqual({ '$__empty': '' })
})

it('returns plain Lua tables from client APIs without exposing JS constructors', async () => {
    const { runScripted } = await import('./scriptings')
    const result = await runScripted(`
        onStart = async(function(id)
            local response = simpleLLM(id, 'prompt'):await()
            assert(type(response) == 'table')
            assert(response.constructor == nil)
            assert(response.success == true)
            local scores = similarity(id, 'query', {'first', 'second'}):await()
            assert(type(scores) == 'table' and scores.constructor == nil)
            local names = {}
            for _, score in ipairs(scores) do
                assert(type(score) == 'table' and score.constructor == nil)
                table.insert(names, score[1])
            end
            return response.result .. ':' .. table.concat(names, ',')
        end)
    `, {
        char: { type: 'character' } as never,
        chat: { message: [] } as never,
        setVar: () => {},
        getVar: () => 'null',
        lowLevelAccess: true,
        mode: 'start',
    })

    expect(result.res).toBe('client result:second,first')
    expect(result.stopSending).toBe(false)
})

it.each(['button', 'manual'])('keeps %s Lua variables, lore and character mutations on the starting chat', async mode => {
    const { runLuaInteractionTrigger } = await import('./scriptings')
    const { selectedCharID } = await import('../stores.svelte')
    const origin = { id: 'origin', message: [], localLore: [], scriptstate: { $value: 'origin' } }
    const other = { id: 'other', message: [], localLore: [], scriptstate: { $value: 'other' } }
    const callback = mode === 'button' ? 'onButtonClick' : 'run'
    const code = `${callback} = async(function(id)
        alertInput(id, 'wait'):await()
        setChatVar(id, 'value', getChatVar(id, 'value') .. '-changed')
        upsertLocalLoreBook(id, 'local', 'content', {})
        setName(id, 'Updated')
    end)`
    const character = {
        chaId: 'character', type: 'character', name: 'Original', defaultVariables: '',
        chats: [origin, other],
        triggerscript: [{ comment: 'run', type: 'manual', conditions: [], effect: [{ type: 'triggerlua', code }] }],
    }
    const another = { chaId: 'another', type: 'character', name: 'Another', chats: [other] }
    state.db.characters = [character, another]
    selectedCharID.set(0)
    let opened!: () => void
    let resume!: (value: string) => void
    const waiting = new Promise<void>(resolve => { opened = resolve })
    state.alertInput.mockImplementationOnce(() => {
        opened()
        return new Promise<string>(resolve => { resume = resolve })
    })
    const run = mode === 'button'
        ? runLuaInteractionTrigger('button', character as never, 'run', origin as never)
        : (await import('./triggers')).runTrigger(character as never, 'manual', { chat: origin as never, manualName: 'run' })
    await waiting
    const { setChatPage } = await import('../storage/chatSelection.svelte')
    setChatPage(character, 1)
    selectedCharID.set(1)
    resume('done')
    const result = await run

    expect(result.chat.scriptstate.$value).toBe('origin-changed')
    expect(result.chat.localLore).toMatchObject([{ comment: 'local', content: 'content' }])
    expect(origin.scriptstate.$value).toBe('origin-changed')
    expect(other.scriptstate.$value).toBe('other')
    expect(other.localLore).toEqual([])
    expect(character.name).toBe('Updated')
    expect(another.name).toBe('Another')
})

it('uses the selected auxiliary mode with the originating chat and module', async () => {
    state.request.mockImplementation(async (_options, mode) => ({ type: 'success', result: mode! }))
    const { runScripted } = await import('./scriptings')
    const chat = { id: 'origin', message: [] }
    const result = await runScripted(`
        onStart = async(function(id)
            for _, mode in ipairs({'memory', 'otherAx', 'submodel', 'translate'}) do
                local response = axLLM(id, {{role = 'user', content = 'prompt'}}, false, {mode = mode})
                assert(response.success and response.result == mode)
            end
            local retired = axLLM(id, {{role = 'user', content = 'retired'}}, false, {mode = 'emotion'})
            assert(retired.success and retired.result == 'otherAx')
            local response = axLLM(id, {{role = 'user', content = 'default'}})
            local invalid = axLLM(id, {{role = 'user', content = 'invalid'}}, false, {mode = 'model'})
            assert(not invalid.success and invalid.result == 'Error: Invalid axLLM mode: model')
            return response.result
        end)
    `, {
        char: { type: 'character' } as never, chat: chat as never,
        mode: 'start', moduleId: 'module', lowLevelAccess: true,
    })

    expect(result.res).toBe('otherAx')
    for (const [options] of state.request.mock.calls) {
        expect(options).toMatchObject({ currentChat: chat, moduleId: 'module' })
    }
})

it('passes the form key and grouped field values to Lua', async () => {
    const { runLuaInteractionTrigger } = await import('./scriptings')
    const chat = { id: 'origin', message: [] }
    const character = {
        type: 'character', chaId: 'character',
        triggerscript: [{ effect: [{ type: 'triggerlua', code: `
            onFormSubmit = async(function(id, key, encoded)
                local meta = json.decode(encoded)
                assert(key == 'settings' and meta.data.choice[2] == 'second')
                setChatVar(id, 'submitted', key .. ':' .. table.concat(meta.data.choice, ','))
                return false
            end)
        ` }] }],
    }
    const result = await runLuaInteractionTrigger('form', character as never, 'settings', chat as never, { data: { choice: ['first', 'second'] } })
    expect(result.chat.scriptstate.$submitted).toBe('settings:first,second')
    expect(result.stopSending).toBe(true)
})

it('forwards valid image orientation and rejects invalid options before generation', async () => {
    const { runScripted } = await import('./scriptings')
    const result = await runScripted(`
        onStart = async(function(id)
            local reference = generateImage(id, 'first', '', {orientation = 'landscape'}):await()
            assert(generateImage(id, 'invalid', '', {orientation = 'square'}):await() == 'Error: Image orientation must be landscape or portrait, received square')
            return reference
        end)
    `, {
        char: { type: 'character', chaId: 'character' } as never,
        chat: { id: 'origin', message: [] } as never,
        lowLevelAccess: true, mode: 'start',
    })
    expect(result.res).toBe('{{inlayed::image}}')
    expect(state.image).toHaveBeenCalledExactlyOnceWith({
        characterId: 'character', roomId: 'origin', prompt: 'first', negativePrompt: '', orientation: 'landscape',
    })
})

it('keeps form submissions separate and recovers their original input and model result', async () => {
    const { runLuaInteractionTrigger, recoverRevenantLuaJobsForChat } = await import('./scriptings')
    const chat = { id: 'recover-origin', message: [{ role: 'user', data: 'form', chatId: 'anchor' }] }
    const code = `onFormSubmit = async(function(id, key, encoded)
        local meta = json.decode(encoded)
        local response = axLLM(id, {{role = 'user', content = meta.data.value}}, false, {mode = 'memory'})
        assert(response.success)
        setChatVar(id, 'submitted', key .. ':' .. meta.data.value .. ':' .. response.result)
    end)`
    const character = {
        type: 'character', chaId: 'recover-character', lowLevelAccess: true,
        chats: [chat], triggerscript: [{ effect: [{ type: 'triggerlua', code }] }],
    }
    state.db.characters = [character]
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    state.request.mockImplementationOnce(async (...args: any[]) => {
        const context = args[0].revenantOperationContext
        state.jobs.push({ jobId: 'finished-model', status: 'generated', operationContext: context, projection: { content: 'saved answer' } })
        throw new Error('page disconnected')
    })
    try {
        await runLuaInteractionTrigger('form', character as never, 'settings', chat as never, { data: { value: 'first' } })
        expect(state.jobs).toHaveLength(1)
        state.request.mockClear()
        state.request.mockImplementationOnce(async options => {
            const context = options.revenantOperationContext
            state.jobs.push({ jobId: 'second-model', status: 'generated', operationContext: context })
            return { type: 'success', result: 'second answer' }
        })
        await runLuaInteractionTrigger('form', character as never, 'settings', chat as never, { data: { value: 'second' } })
        expect(state.request).toHaveBeenCalledTimes(1)
        expect((character.chats[0] as any).scriptstate.$submitted).toBe('settings:second:second answer')

        state.request.mockClear()
        state.save.mockClear()
        state.consume.mockClear()
        state.save.mockImplementationOnce(async () => { expect(state.consume).not.toHaveBeenCalled() })
        await expect(recoverRevenantLuaJobsForChat(character as never, character.chats[0] as never)).resolves.toBe(1)
        expect((character.chats[0] as any).scriptstate.$submitted).toBe('settings:first:saved answer')
        expect(state.request).not.toHaveBeenCalled()
        expect(state.save).toHaveBeenCalledTimes(1)
        expect(state.consume).toHaveBeenCalledWith('finished-model')
    }
    finally { errors.mockRestore() }
})

it('runs edit listeners without granting model access or changing saved permissions', async () => {
    const { runLuaEditTrigger } = await import('./scriptings')
    const trigger = {
        lowLevelAccess: true,
        effect: [{ type: 'triggerlua', code: `
            listenEdit('editOutput', function(id, value)
                pcall(function() axLLM(id, {{role = 'user', content = 'denied'}}) end)
                return value .. '-edited'
            end)
        ` }],
    }
    const character = { type: 'character', lowLevelAccess: true, triggerscript: [trigger], chats: [{ message: [] }] }
    state.db.characters = [character]
    await expect(runLuaEditTrigger(character as never, 'editoutput', 'source')).resolves.toBe('source-edited')
    expect(state.request).not.toHaveBeenCalled()
    expect(trigger.lowLevelAccess).toBe(true)
})
