import { beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
    chat: null as Record<string, unknown> | null,
    database: {
        botPresets: [] as Array<{ id?: string }>,
        personas: [] as Array<{ id?: string }>,
    },
    notifySuccess: vi.fn(),
}))

vi.mock('./storage/database.svelte', () => ({
    getCurrentChat: () => state.chat,
    getDatabase: () => state.database,
}))
vi.mock('./alert', () => ({ notifySuccess: state.notifySuccess }))
vi.mock('src/lang', () => ({
    language: {
        promptBindedSuccess: 'prompt bound',
        personaBindedSuccess: 'persona bound',
        promptUnbindedSuccess: 'prompt unbound',
        personaUnbindedSuccess: 'persona unbound',
    },
}))

import { bindPersonaToCurrentChat, bindPromptPresetToCurrentChat } from './chatBindings'

describe('current chat bindings', () => {
    beforeEach(() => {
        state.chat = {}
        state.database.botPresets = [{}]
        state.database.personas = [{}]
        state.notifySuccess.mockClear()
    })

    it('binds prompt presets and personas to the current chat', () => {
        expect(bindPromptPresetToCurrentChat(0)).toBe(true)
        expect(bindPersonaToCurrentChat(0)).toBe(true)

        expect(state.chat).toMatchObject({
            bindedBotPreset: state.database.botPresets[0].id,
            bindedPersona: state.database.personas[0].id,
        })
        expect(state.notifySuccess).toHaveBeenCalledTimes(2)
    })

    it('clears only the selected binding when the picker selects none', () => {
        state.chat = { bindedBotPreset: 'prompt-id', bindedPersona: 'persona-id' }
        expect(bindPromptPresetToCurrentChat(-1)).toBe(true)
        expect(state.chat).toEqual({ bindedBotPreset: '', bindedPersona: 'persona-id' })
        expect(bindPersonaToCurrentChat(-1)).toBe(true)
        expect(state.chat).toEqual({ bindedBotPreset: '', bindedPersona: '' })
        expect(state.notifySuccess).toHaveBeenNthCalledWith(1, 'prompt unbound')
        expect(state.notifySuccess).toHaveBeenNthCalledWith(2, 'persona unbound')
    })

    it('does not change bindings for a missing chat or an invalid preset', () => {
        state.chat = { bindedBotPreset: 'prompt-id', bindedPersona: 'persona-id' }
        expect(bindPromptPresetToCurrentChat(99)).toBe(false)
        expect(bindPersonaToCurrentChat(-2)).toBe(false)
        expect(state.chat).toEqual({ bindedBotPreset: 'prompt-id', bindedPersona: 'persona-id' })
        state.chat = null
        expect(bindPromptPresetToCurrentChat(-1)).toBe(false)
        expect(bindPersonaToCurrentChat(-1)).toBe(false)
        expect(state.notifySuccess).not.toHaveBeenCalled()
    })
})
