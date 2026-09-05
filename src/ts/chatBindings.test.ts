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
})
