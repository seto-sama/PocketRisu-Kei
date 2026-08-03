import { describe, expect, it } from 'vitest'
import { invokeLuaMode, registerLuaCoreApis, type LuaCoreAdapter } from './luaCore'

function apiHarness() {
    const functions: Record<string, (...args: any[]) => any> = {}
    let stopped = false
    let chat = { message: [{ role: 'char', data: 'hello' }], note: 'note' }
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
    it('binds deterministic APIs to the current invocation adapter', () => {
        const harness = apiHarness()
        harness.functions.setChatVar('denied', 'mood', 'bad')
        harness.functions.setChatVar('allowed', 'mood', 'happy')
        harness.functions.addChat('allowed', 'user', 'next')
        harness.functions.setName('allowed', 'Updated')
        harness.functions.stopChat('allowed')

        expect(harness.variables).toEqual({ mood: 'happy' })
        expect(harness.chat.message.at(-1)).toEqual({ role: 'user', data: 'next' })
        expect(harness.character.name).toBe('Updated')
        expect(harness.stopped).toBe(true)
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

    it('dispatches normal and edit callbacks through one mode mapper', async () => {
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
})
