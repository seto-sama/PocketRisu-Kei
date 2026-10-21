import { describe, expect, it } from 'vitest'
import { assertChatIdentity } from '../../../shared/chatShape.mjs'
import { invokeLuaMode, luaMayListenForEditMode, registerLuaCoreApis, type LuaCoreAdapter, type LuaCoreChat } from './luaCore'

function apiHarness() {
    const functions: Record<string, (...args: any[]) => any> = {}
    let stopped = false
    let chat: LuaCoreChat = { message: [{ role: 'char', data: 'hello', chatId: 'existing-message' }], note: 'note' }
    const character = { name: 'Alice', firstMessage: 'first' }
    const variables: Record<string, string> = {}
    const adapter: LuaCoreAdapter = {
        canSetVariable: key => key === 'allowed',
        canMutate: key => key === 'allowed',
        getChat: () => chat,
        getCharacter: () => character,
        getVar: key => variables[key] ?? 'null',
        setVar: (key, value) => { variables[key] = value },
        getGlobalVar: () => 'global',
        stop: () => { stopped = true },
        render: value => `rendered:${value}`,
    }
    registerLuaCoreApis((name, handler) => { functions[name] = handler }, () => adapter)
    return { functions, variables, character, get chat() { return chat }, set chat(value) { chat = value }, get stopped() { return stopped } }
}

describe('Lua core', () => {
    it('only skips edit modes that cannot be registered by the script', () => {
        expect(luaMayListenForEditMode('function button() end', 'editDisplay')).toBe(false)
        expect(luaMayListenForEditMode("listenEdit('editInput', handler)", 'editDisplay')).toBe(false)
        expect(luaMayListenForEditMode("listenEdit('editDisplay', handler)", 'editDisplay')).toBe(true)
        expect(luaMayListenForEditMode('listenEdit(mode, handler)', 'editDisplay')).toBe(true)
        expect(luaMayListenForEditMode('local register = listenEdit', 'editDisplay')).toBe(true)
    })

    it('applies permitted mutations and creates messages with valid identities', () => {
        const harness = apiHarness()
        harness.functions.setChatVar('denied', 'mood', 'bad')
        harness.functions.setChatVar('allowed', 'mood', 'happy')
        harness.functions.addChat('allowed', 'user', 'next')
        harness.functions.insertChat('allowed', 1, 'char', 'inserted')
        harness.functions.setName('allowed', 'Updated')
        harness.functions.stopChat('allowed')

        expect(harness.variables).toEqual({ mood: 'happy' })
        expect(harness.chat.message).toMatchObject([
            { role: 'char', data: 'hello', chatId: 'existing-message' },
            { role: 'char', data: 'inserted' },
            { role: 'user', data: 'next' },
        ])
        expect(() => assertChatIdentity({ ...harness.chat, id: 'room' }, 'room')).not.toThrow()
        expect(harness.character.name).toBe('Updated')
        expect(harness.stopped).toBe(true)
    })

    it('preserves existing message metadata and assigns identities to additions in setFullChat', () => {
        const harness = apiHarness()
        harness.chat.message = [{
            role: 'char',
            data: 'before',
            time: 10,
            chatId: 'message-1',
            swipes: ['before', 'alternate'],
            swipeId: 1,
            generationInfo: { model: 'model-a' },
        }]

        harness.functions.setFullChatMain('allowed', JSON.stringify([
            { role: 'char', data: 'after', time: 20 },
            { role: 'user', data: 'added' },
        ]))

        expect(harness.chat.message[0]).toEqual({
            role: 'char',
            data: 'after',
            time: 20,
            chatId: 'message-1',
            swipes: ['before', 'after'],
            swipeId: 1,
            generationInfo: { model: 'model-a' },
        })
        expect(harness.chat.message[1]).toMatchObject({ role: 'user', data: 'added' })
        expect(() => assertChatIdentity({ ...harness.chat, id: 'room' }, 'room')).not.toThrow()
    })

    it('replaces the whole chat without inferring a swipe deletion from its shorter length', () => {
        const harness = apiHarness()
        harness.chat.message = [
            { role: 'user', data: 'question', chatId: 'user-1' },
            { role: 'char', data: 'selected', swipes: ['previous', 'selected'], swipeId: 1 },
        ]

        harness.functions.setFullChatMain('allowed', JSON.stringify([{ role: 'user', data: 'question' }]))

        expect(harness.chat.message).toMatchObject([{ role: 'user', data: 'question', chatId: 'user-1' }])
        expect(harness.chat.message).toHaveLength(1)
    })

    it.each(['edited', ''])('updates only the selected swipe through setChat with %j', content => {
        const harness = apiHarness()
        harness.chat.message[0] = {
            role: 'char', data: 'selected', chatId: 'message-1',
            swipes: ['other', 'selected'], swipeId: 1,
            swipeMetadata: [{ chatId: 'response-1' }, { chatId: 'response-2' }],
        }

        harness.functions.setChat('denied', 0, 'denied')
        expect(harness.chat.message[0].data).toBe('selected')
        harness.functions.setChat('allowed', 0, content)

        expect(harness.chat.message[0]).toMatchObject({
            data: content, swipes: ['other', content], swipeId: 1,
            swipeMetadata: [{ chatId: 'response-1' }, { chatId: 'response-2' }],
        })
    })

    it('does not retain state from a previous cached-engine invocation', () => {
        const functions: Record<string, (...args: any[]) => any> = {}
        const first = apiHarness()
        const second = apiHarness()
        let active = first
        registerLuaCoreApis((name, handler) => { functions[name] = handler }, () => ({
            canSetVariable: () => true,
            canMutate: () => true,
            getChat: () => active.chat,
            getCharacter: () => active.character,
            getVar: key => active.variables[key] ?? 'null',
            setVar: (key, value) => { active.variables[key] = value },
            getGlobalVar: () => 'null',
            stop: () => undefined,
            render: String,
        }))

        functions.setChatVar('allowed', 'value', 'first')
        active = second
        functions.setChatVar('allowed', 'value', 'second')
        expect(first.variables.value).toBe('first')
        expect(second.variables.value).toBe('second')
    })

    it('invokes output and edit callbacks and preserves their results', async () => {
        const calls: unknown[][] = []
        const global = {
            get: (name: string) => name === 'onOutput'
                ? (...args: unknown[]) => { calls.push(args); return false }
                : name === 'callListenMain'
                    ? (_mode: string, _id: string, value: string) => JSON.stringify(`${JSON.parse(value)}-edited`)
                    : undefined,
        }

        const output = await invokeLuaMode(global, 'output', 'key', '', {})
        const edited = await invokeLuaMode(global, 'editOutput', 'key', 'answer', {})
        expect(output.result).toBe(false)
        expect(calls).toEqual([['key']])
        expect(edited.data).toBe('answer-edited')
    })

    it('does not serialize edit data when the loaded script has no listener for that mode', async () => {
        let editCalls = 0
        const global = {
            get: (name: string) => name === 'hasEditListener'
                ? (mode: string) => mode === 'editInput'
                : name === 'callListenMain'
                    ? () => { editCalls++; return JSON.stringify('unexpected') }
                    : undefined,
        }

        const data = { nested: ['large', 'message'] }
        const skipped = await invokeLuaMode(global, 'editDisplay', 'key', data, {})
        expect(skipped).toEqual({ result: undefined, data })
        expect(editCalls).toBe(0)
    })
})
