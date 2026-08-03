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
        isContinuation: false,
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
        const result = await runRevenantOutputStage({
            text: 'answer', recipe: recipe(),
            job: { completedAt: 123, generationInfo: { model: 'test' } },
            transformOutput: pipelinePkg.runRevenantOutputTransform,
        })

        expect(result.status).toBe('completed')
        expect(result.text).toBe('answer-final')
        expect(result.chat.message.at(-1)).toMatchObject({
            role: 'char', data: 'answer-final', chatId: 'message-1', time: 123,
        })
        expect(recipe().chat.message).toHaveLength(1)
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

    it('delegates dynamic asset matching after regex and materializes its response', async () => {
        const input = recipe()
        input.database.dynamicAssets = true
        input.character.additionalAssets = [['happy', 'asset-id', 'image/png']]
        input.character.triggerscript = []
        const job = { completedAt: 1, generationInfo: {}, promptInfo: {} }
        const transformOutput = (text: string, _recipe: any, chat: any) => ({
            text, chat, foregroundEffects: [], errors: [],
        })
        const waiting = await runRevenantOutputStage({
            text: '{{image::hapy}}', recipe: input, job, transformOutput,
        })
        expect(waiting).toMatchObject({
            status: 'waiting_client',
            action: {
                actionId: 'output.dynamic-assets',
                kind: 'utility.dynamic-assets',
                payload: {
                    text: '{{image::hapy}}',
                    assetNames: ['happy'],
                },
            },
        })

        const completed = await runRevenantOutputStage({
            text: '{{image::hapy}}', recipe: input, job, transformOutput,
            responses: { 'output.dynamic-assets': '{{image::happy}}' },
        })
        expect(completed).toMatchObject({
            status: 'completed',
            text: '{{image::happy}}',
        })
    })
})
