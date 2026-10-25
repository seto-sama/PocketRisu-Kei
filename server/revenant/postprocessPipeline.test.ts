// @vitest-environment node
import { describe, expect, it } from 'vitest'
import pipelinePkg from './postprocessPipeline.cjs'

const { runRevenantOutputStage, runRevenantTriggerStage } = pipelinePkg as {
    runRevenantOutputStage: (options: any) => Promise<any>
    runRevenantTriggerStage: (options: any) => Promise<any>
}

function recipe() {
    return {
        schemaVersion: 1,
        messageChatId: 'message-1',
        providerBackend: 'plugin',
        modelPreset: { id: 'plugin' },
        character: {
            chaId: 'character-1', name: 'Alice', lowLevelAccess: true,
            customscript: [{ type: 'editoutput', in: 'edited', out: 'final', flag: 'g', ableFlag: true }],
            triggerscript: [
                {
                    type: 'output', conditions: [], lowLevelAccess: true,
                    effect: [{ type: 'triggerlua', code: `
                        listenEdit('editOutput', function(id, value) return value .. '-edited' end)
                        function onOutput(id) setChatVar(id, 'lua-output', 'once') end
                    ` }],
                },
                {
                    type: 'output', conditions: [], lowLevelAccess: true,
                    effect: [{ type: 'setvar', operator: '=', var: 'trigger-output', value: 'once' }],
                },
            ],
        },
        chat: { id: 'room-1', message: [{ role: 'user', data: 'hello', chatId: 'user-1' }] },
        database: { presetRegex: [], templateDefaultVariables: '', globalChatVariables: {}, username: 'Bob', personas: [] },
        modules: [], moduleRegexScripts: [], moduleTriggers: [],
    }
}

describe('revenant terminal postprocess pipeline', () => {
    it('runs Lua editOutput and regex before adding the assistant draft', async () => {
        const input = recipe()
        const result = await runRevenantOutputStage({
            text: 'answer', recipe: input,
            job: { completedAt: 123, generationInfo: { model: 'test' } },
            transformOutput: pipelinePkg.runRevenantOutputTransform,
        })

        expect(result.status).toBe('completed')
        expect(result.text).toBe('answer-final')
        expect(result.chat.message.at(-1)).toMatchObject({
            role: 'char', data: 'answer-final', chatId: 'message-1', time: 123,
        })
        expect(input.chat.message).toHaveLength(1)
    })

    it('runs output Lua and output triggers after the transformed message exists', async () => {
        const output = await runRevenantOutputStage({
            text: 'answer', recipe: recipe(), job: {},
            transformOutput: pipelinePkg.runRevenantOutputTransform,
        })
        const trigger = await runRevenantTriggerStage({
            recipe: recipe(), text: output.text, chat: output.chat,
        })

        expect(trigger.status).toBe('completed')
        expect(trigger.chat.scriptstate).toEqual({
            '$lua-output': 'once',
            '$trigger-output': 'once',
        })
    })

    it.each(['lua', 'v2'])('keeps the active reroll swipe in sync after %s edits its body', async source => {
        const input = recipe()
        const previous = {
            role: 'char', data: 'old answer', chatId: 'old-response',
            swipes: ['old answer'], swipeId: 0,
        }
        input.rerollSnapshot = { targetIndex: 1, targetMessage: previous, trailingMessages: [] }
        input.character.triggerscript = [{
            type: 'output', conditions: [], lowLevelAccess: true,
            effect: source === 'lua'
                ? [{ type: 'triggerlua', code: 'function onOutput(id) setChat(id, 1, "edited answer") end' }]
                : [{
                    type: 'v2ModifyChat', indent: 0, index: '1', indexType: 'value',
                    value: 'edited answer', valueType: 'value',
                }],
        }] as any
        const output = await runRevenantOutputStage({
            text: 'new answer', recipe: input, job: {},
            transformOutput: pipelinePkg.runRevenantOutputTransform,
        })

        const trigger = await runRevenantTriggerStage({ recipe: input, text: output.text, chat: output.chat })

        expect(trigger.status).toBe('completed')
        expect(trigger.chat.message[1]).toMatchObject({
            data: 'edited answer', swipes: ['old answer', 'edited answer'], swipeId: 1,
        })
        expect(previous.swipes).toEqual(['old answer'])
    })

    it.each(['lua', 'v2'])('restores the previous swipe when %s deletes only the latest reroll message', async source => {
        const input = recipe()
        const previous = {
            role: 'char', data: 'old answer', chatId: 'old-response',
            generationInfo: { model: 'previous model' }, time: 10,
        }
        input.rerollSnapshot = { targetIndex: 1, targetMessage: previous, trailingMessages: [] }
        input.character.triggerscript = [{
            type: 'output', conditions: [], lowLevelAccess: true,
            effect: source === 'lua'
                ? [{ type: 'triggerlua', code: 'function onOutput(id) removeChat(id, 1) end' }]
                : [{ type: 'v2CutChat', indent: 0, start: '0', startType: 'value', end: '1', endType: 'value' }],
        }] as any
        const output = await runRevenantOutputStage({
            text: 'new answer', recipe: input,
            job: { completedAt: 20, generationInfo: { model: 'current model' } },
            transformOutput: pipelinePkg.runRevenantOutputTransform,
        })

        const trigger = await runRevenantTriggerStage({ recipe: input, text: output.text, chat: output.chat })

        expect(trigger.status).toBe('completed')
        expect(trigger.chat.message).toHaveLength(2)
        expect(trigger.chat.message[1]).toMatchObject(previous)
        expect(trigger.chat.message[1]).not.toHaveProperty('swipes')
    })

    it('preserves per-swipe diagnostics from the generation placeholder', async () => {
        const input = recipe()
        input.messageChatId = 'generation-2'
        input.rerollSnapshot = {
            targetIndex: 1,
            targetMessage: {
                role: 'char',
                data: 'old answer',
                chatId: 'generation-1',
                swipes: ['old answer'],
                swipeId: 0,
            },
            trailingMessages: [],
        }
        input.chat.message.push({
            role: 'char',
            data: '',
            chatId: 'generation-2',
            isRecovering: true,
            recoveryDisplayData: '',
            swipes: ['old answer', ''],
            swipeId: 1,
            swipeMetadata: [
                { generationInfo: { generationId: 'generation-1', inputTokens: 100 } },
                { generationInfo: { generationId: 'generation-2', inputTokens: 200 } },
            ],
        })

        const result = await runRevenantOutputStage({
            text: 'new answer',
            recipe: input,
            job: {
                completedAt: 123,
                generationInfo: { generationId: 'generation-2', inputTokens: 200 },
            },
            transformOutput: pipelinePkg.runRevenantOutputTransform,
        })

        expect(result.chat.message[1]).toMatchObject({
            data: 'new answer-final',
            swipeId: 1,
            swipes: ['old answer', 'new answer-final'],
            swipeMetadata: [
                { generationInfo: { generationId: 'generation-1', inputTokens: 100 } },
                { generationInfo: { generationId: 'generation-2', inputTokens: 200 } },
            ],
        })
        expect(result.chat.message[1]).not.toHaveProperty('isRecovering')
        expect(result.chat.message[1]).not.toHaveProperty('recoveryDisplayData')
    })
})
