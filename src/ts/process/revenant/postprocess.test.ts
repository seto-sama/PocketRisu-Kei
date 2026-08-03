import { describe, expect, it } from 'vitest'
import type { RevenantPostprocessRecipe } from './types'
import { runRevenantOutputTransform } from './postprocess'

function recipe(): RevenantPostprocessRecipe {
    return {
        schemaVersion: 1,
        messageChatId: 'message-2',
        isContinuation: false,
        providerBackend: 'http',
        modelPreset: {},
        character: {
            type: 'character', chaId: 'character-1', name: 'Alice', chats: [], chatPage: 0,
            customscript: [{
                type: 'editoutput', in: 'Hello (.+)', out: '{{char}} says: $1', ableFlag: true, flag: 'g',
            }],
        } as any,
        chat: {
            id: 'room-1',
            message: [
                { role: 'user', data: 'Hi', chatId: 'message-1' },
                { role: 'char', data: '', chatId: 'message-2' },
            ],
        } as any,
        database: {
            presetRegex: [{
                type: 'editoutput', in: '\\[happy\\]', out: '@@emo happy', ableFlag: true, flag: 'g', comment: '',
            }],
            templateDefaultVariables: '', globalChatVariables: {}, username: 'Bob', userIcon: '',
            personaPrompt: '', selectedPersona: 0, personas: [], dynamicAssets: false,
            dynamicAssetsEditDisplay: false, igpPrompt: '',
        },
        modules: [], moduleRegexScripts: [], moduleTriggers: [],
    }
}

describe('revenant output transform', () => {
    it('runs persisted regex and CBS once over the terminal model output', () => {
        const result = runRevenantOutputTransform('Hello Bob [happy]', recipe())
        expect(result.text).toBe('Alice says: Bob [happy]')
        expect(result.foregroundEffects).toEqual([{ kind: 'emotion', name: 'happy' }])
        expect(result.errors).toEqual([])
    })

    it('does not execute removed plugin v2 output hooks', () => {
        const result = runRevenantOutputTransform('Hello Bob', recipe())
        expect(result.text).toBe('Alice says: Bob')
    })
})
