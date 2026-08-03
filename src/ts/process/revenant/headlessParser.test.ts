import { describe, expect, it } from 'vitest'
import type { RevenantPostprocessRecipe } from './types'
import { renderRevenantTemplate } from './headlessParser'

function recipe(): RevenantPostprocessRecipe {
    return {
        schemaVersion: 1,
        messageChatId: 'message-2',
        isContinuation: false,
        providerBackend: 'http',
        character: {
            type: 'character',
            chaId: 'character-1',
            name: 'Alice',
            nickname: 'Al',
            defaultVariables: 'mood=calm',
            chats: [],
            chatPage: 0,
        } as any,
        chat: {
            id: 'room-1',
            message: [
                { role: 'user', data: 'Hello', chatId: 'message-1' },
                { role: 'char', data: 'Hi', chatId: 'message-2' },
            ],
            scriptstate: { $score: '3' },
        } as any,
        database: {
            presetRegex: [],
            templateDefaultVariables: '',
            globalChatVariables: { toggle_detail: '1' },
            username: 'Bob',
            userIcon: '',
            personaPrompt: '',
            selectedPersona: 0,
            personas: [],
            dynamicAssets: false,
            dynamicAssetsEditDisplay: false,
            igpPrompt: '',
        },
        modules: [],
        moduleRegexScripts: [],
        moduleTriggers: [],
    }
}

describe('revenant headless CBS parser', () => {
    it('uses the persisted character, user, chat, and variable context', () => {
        const result = renderRevenantTemplate(
            '{{user}}/{{char}}: {{lastmessage}} score={{getvar::score}} mood={{getvar::mood}}',
            recipe(),
        )
        expect(result.text).toBe('Bob/Al: Hi score=3 mood=calm')
    })

    it('evaluates nested conditions and reusable functions deterministically', () => {
        const result = renderRevenantTemplate(
            '{{#func greet who}}Hello {{arg::0}}{{/func}}'
            + '{{#when::1}} {{call::greet::Alice}} {{#if 0}}bad{{:else}}ok{{/if}}{{/when}}',
            recipe(),
        )
        expect(result.text).toBe('Hello Alice ok')
    })
})
