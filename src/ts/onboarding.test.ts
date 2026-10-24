import { writable } from 'svelte/store'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { character, Chat } from './storage/database.svelte'

const mocks = vi.hoisted(() => ({
    characters: [] as character[],
    commitTriggerChat: vi.fn(),
}))

vi.mock('./stores.svelte', () => ({
    DBState: { db: { templateDefaultVariables: '' } },
    selectedCharID: writable(0),
    selIdState: { selId: 0 },
    ReloadGUIPointer: writable(0),
}))
vi.mock('./process/triggerOrigin', () => ({
    resolveTriggerOrigin: ({ characterId, chatId }: { characterId: string, chatId: string }) => {
        const char = mocks.characters.find((c) => c.chaId === characterId)
        const index = char?.chats.findIndex((c) => c.id === chatId) ?? -1
        return char && index >= 0 ? { character: char, index, chat: char.chats[index] } : null
    },
    commitTriggerChat: mocks.commitTriggerChat,
}))

import { applyOnboardingAnswers, normalizeOnboarding, readFormAnswers } from './onboarding'

function chat(id: string, extra: Partial<Chat> = {}): Chat {
    return { id, message: [], note: '', name: id, localLore: [], ...extra }
}

describe('onboarding', () => {
    beforeEach(() => {
        mocks.commitTriggerChat.mockReset().mockResolvedValue(true)
        mocks.characters = [{
            chaId: 'char',
            defaultVariables: 'route=default',
            onboarding: normalizeOnboarding({
                enabled: true,
                questions: [{ id: 'q', varName: 'route', options: [{ label: 'A' }] }],
            }),
            chats: [chat('opened', { scriptstate: { $kept: 'yes' } }), chat('selected-later')],
        } as unknown as character]
    })

    it('commits answers to the chat it was opened for and marks it done', async () => {
        await expect(applyOnboardingAnswers({ characterId: 'char', chatId: 'opened' }, { route: 'a', '': 'ignored' }))
            .resolves.toBe(true)

        expect(mocks.commitTriggerChat).toHaveBeenCalledWith(
            { characterId: 'char', chatId: 'opened' },
            expect.objectContaining({ id: 'opened', onboardingDone: true, scriptstate: { $kept: 'yes', $route: 'a' } }),
        )
        expect(mocks.characters[0].chats[1]).not.toHaveProperty('onboardingDone')
    })

    it('does not write to a deleted or unloaded chat', async () => {
        mocks.characters[0].chats[0]._placeholder = true
        await expect(applyOnboardingAnswers({ characterId: 'char', chatId: 'opened' }, {})).resolves.toBe(false)
        await expect(applyOnboardingAnswers({ characterId: 'char', chatId: 'deleted' }, {})).resolves.toBe(false)
        expect(mocks.commitTriggerChat).not.toHaveBeenCalled()
    })

    it('prefills answers from chat and default variables', () => {
        const [char] = mocks.characters
        const questions = char.onboarding!.questions
        expect(readFormAnswers(char, chat('fresh'), questions)).toEqual({ route: 'default' })
        expect(readFormAnswers(char, chat('answered', { scriptstate: { $route: 'b' } }), questions)).toEqual({ route: 'b' })
    })
})
