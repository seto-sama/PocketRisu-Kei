// @vitest-environment node
import { describe, expect, it } from 'vitest'
import executorPkg from './triggerExecutor.cjs'

const { executeRevenantOutputTriggers } = executorPkg as {
    executeRevenantOutputTriggers: (options: any) => Promise<any>
}

function recipe() {
    return {
        providerBackend: 'plugin',
        modelPreset: { id: 'plugin-preset' },
        character: {
            name: 'Alice',
            lowLevelAccess: true,
            triggerscript: [{
                type: 'output', conditions: [], lowLevelAccess: true,
                effect: [
                    { type: 'setvar', operator: '=', var: 'mood', value: 'happy' },
                    { type: 'runLLM', value: 'judge {{lastmessage}}', inputVar: 'judge' },
                ],
            }],
        },
        database: { globalChatVariables: {}, templateDefaultVariables: '', username: 'Bob', personas: [] },
        modules: [], moduleTriggers: [],
        chat: { id: 'room-1', message: [{ role: 'char', data: 'answer' }] },
    }
}

describe('revenant output trigger executor', () => {
    it('inherits character low-level access for Lua auxiliary calls', async () => {
        const input = recipe()
        input.auxProviders = {
            otherAx: { backend: 'plugin', modelPreset: { id: 'ax-preset' } },
        }
        input.character.triggerscript = [{
            type: 'output', conditions: [],
            effect: [{
                type: 'triggerlua',
                code: `
                    onOutput = async(function(id)
                        axLLM(id, {{ role = 'user', content = 'status' }})
                    end)
                `,
            }],
        }] as any

        const waiting = await executeRevenantOutputTriggers({
            recipe: input, chat: input.chat, text: 'answer',
        })

        expect(waiting).toMatchObject({
            status: 'waiting_client',
            action: {
                actionId: 'trigger.0.0.provider.axllm:0',
                kind: 'provider.axllm',
                payload: {
                    backend: 'plugin',
                    modelPreset: { id: 'ax-preset' },
                },
            },
        })
    })

    it('replays deterministic mutations around a plugin waiting_client action', async () => {
        const waiting = await executeRevenantOutputTriggers({ recipe: recipe(), chat: recipe().chat, text: 'answer' })
        expect(waiting).toMatchObject({
            status: 'waiting_client',
            action: {
                actionId: 'trigger.0.1.provider.llm',
                kind: 'provider.llm',
                payload: { backend: 'plugin' },
            },
        })
        const completed = await executeRevenantOutputTriggers({
            recipe: recipe(), chat: recipe().chat, text: 'answer',
            responses: { 'trigger.0.1.provider.llm': { success: true, result: 'safe' } },
        })
        expect(completed.status).toBe('completed')
        expect(completed.chat.scriptstate).toEqual({ $mood: 'happy', $judge: 'safe' })
    })

    it('runs v2 local variables, loops, conditions, arrays, and dictionaries on the server', async () => {
        const input = recipe()
        input.character.triggerscript = [{
            type: 'output', conditions: [], lowLevelAccess: true,
            effect: [
                { type: 'v2DeclareLocalVar', var: 'sum', value: '0', valueType: 'value', indent: 0 },
                { type: 'v2LoopNTimes', value: '3', valueType: 'value', indent: 0 },
                { type: 'v2SetVar', var: 'sum', value: '1', valueType: 'value', operator: '+=', indent: 1 },
                { type: 'v2EndIndent', indent: 1, endOfLoop: true },
                { type: 'v2IfAdvanced', source: 'sum', sourceType: 'var', target: '3', targetType: 'value', condition: '=', indent: 0 },
                { type: 'v2SetVar', var: 'passed', value: 'yes', valueType: 'value', operator: '=', indent: 1 },
                { type: 'v2EndIndent', indent: 1 },
                { type: 'v2MakeArrayVar', var: 'items', indent: 0 },
                { type: 'v2PushArrayVar', var: 'items', value: 'alpha', valueType: 'value', indent: 0 },
                { type: 'v2PushArrayVar', var: 'items', value: 'beta', valueType: 'value', indent: 0 },
                { type: 'v2JoinArrayVar', var: 'items', varType: 'var', delimiter: ',', delimiterType: 'value', outputVar: 'joined', indent: 0 },
                { type: 'v2MakeDictVar', var: 'record', indent: 0 },
                { type: 'v2SetDictVar', var: 'record', varType: 'var', key: 'answer', keyType: 'value', value: '42', valueType: 'value', indent: 0 },
                { type: 'v2GetDictVar', var: 'record', varType: 'var', key: 'answer', keyType: 'value', outputVar: 'answer', indent: 0 },
            ],
        }] as any

        const result = await executeRevenantOutputTriggers({
            recipe: input, chat: input.chat, text: 'answer',
        })

        expect(result.errors).toEqual([])
        expect(result.chat.scriptstate).toEqual({
            $passed: 'yes',
            $items: '["alpha","beta"]',
            $joined: 'alpha,beta',
            $record: '{"answer":"42"}',
            $answer: '42',
        })
    })

    it('returns targeted persistent mutations for server materialization', async () => {
        const input = recipe()
        input.database.personaPrompt = 'old persona'
        input.database.selectedPersona = 0
        input.database.personas = [{ personaPrompt: 'old persona' }]
        input.character.desc = 'old description'
        input.character.globalLore = []
        input.character.triggerscript = [{
            type: 'output', conditions: [], lowLevelAccess: true,
            effect: [
                { type: 'v2SetCharacterDesc', value: 'new description', valueType: 'value', indent: 0 },
                { type: 'v2SetPersonaDesc', value: 'new persona', valueType: 'value', indent: 0 },
                {
                    type: 'v2CreateLorebook', name: 'Entry', nameType: 'value',
                    key: 'key', keyType: 'value', content: 'content', contentType: 'value',
                    insertOrder: '10', insertOrderType: 'value', indent: 0,
                },
            ],
        }] as any

        const result = await executeRevenantOutputTriggers({
            recipe: input, chat: input.chat, text: 'answer',
        })

        expect(result.mutations).toMatchObject({
            character: {
                desc: 'new description',
                globalLore: [{ comment: 'Entry', key: 'key', content: 'content' }],
            },
            database: {
                personaPrompt: 'new persona',
                personas: [{ personaPrompt: 'new persona' }],
            },
        })
    })

    it('runs named manual triggers recursively without colliding delegated action ids', async () => {
        const input = recipe()
        input.character.triggerscript = [
            {
                comment: 'output', type: 'output', conditions: [], lowLevelAccess: true,
                effect: [{ type: 'v2RunTrigger', target: 'nested', indent: 0 }],
            },
            {
                comment: 'nested', type: 'manual', conditions: [], lowLevelAccess: true,
                effect: [{ type: 'runLLM', value: 'nested prompt', inputVar: 'nestedResult' }],
            },
        ] as any

        const waiting = await executeRevenantOutputTriggers({
            recipe: input, chat: input.chat, text: 'answer',
        })

        expect(waiting).toMatchObject({
            status: 'waiting_client',
            action: {
                actionId: 'trigger.0.0.manual.1.0.provider.llm',
                kind: 'provider.llm',
            },
        })
        const completed = await executeRevenantOutputTriggers({
            recipe: input,
            chat: input.chat,
            text: 'answer',
            responses: {
                'trigger.0.0.manual.1.0.provider.llm': { success: true, result: 'nested answer' },
            },
        })
        expect(completed.chat.scriptstate).toMatchObject({ $nestedResult: 'nested answer' })
    })

    it('assigns distinct replay keys to delegated actions inside a loop', async () => {
        const input = recipe()
        input.character.triggerscript = [{
            type: 'output', conditions: [], lowLevelAccess: true,
            effect: [
                { type: 'v2LoopNTimes', value: '2', valueType: 'value', indent: 0 },
                { type: 'runLLM', value: 'loop prompt', inputVar: 'loopResult', indent: 1 },
                { type: 'v2EndIndent', indent: 1, endOfLoop: true },
            ],
        }] as any
        const firstActionId = 'trigger.0.1.provider.llm'
        const secondActionId = 'trigger.0.1.visit-2.provider.llm'

        const first = await executeRevenantOutputTriggers({
            recipe: input, chat: input.chat, text: 'answer',
        })
        expect(first.action.actionId).toBe(firstActionId)

        const second = await executeRevenantOutputTriggers({
            recipe: input,
            chat: input.chat,
            text: 'answer',
            responses: { [firstActionId]: { success: true, result: 'first' } },
        })
        expect(second.action.actionId).toBe(secondActionId)

        const completed = await executeRevenantOutputTriggers({
            recipe: input,
            chat: input.chat,
            text: 'answer',
            responses: {
                [firstActionId]: { success: true, result: 'first' },
                [secondActionId]: { success: true, result: 'second' },
            },
        })
        expect(completed.chat.scriptstate.$loopResult).toBe('second')
    })

    it('delegates v2 submodel calls with the snapshotted submodel preset', async () => {
        const input = recipe()
        input.auxProviders = {
            submodel: { backend: 'plugin', modelPreset: { id: 'sub-preset' } },
        }
        input.character.triggerscript = [{
            type: 'output', conditions: [], lowLevelAccess: true,
            effect: [{
                type: 'v2RunLLM', value: 'sub prompt', valueType: 'value',
                model: 'submodel', outputVar: 'subResult', indent: 0,
            }],
        }] as any

        const waiting = await executeRevenantOutputTriggers({
            recipe: input, chat: input.chat, text: 'answer',
        })

        expect(waiting.action).toMatchObject({
            kind: 'provider.llm',
            payload: {
                mode: 'submodel',
                backend: 'plugin',
                modelPreset: { id: 'sub-preset' },
            },
        })
    })

    it('does not let prompt-stop signals truncate terminal output effects', async () => {
        const input = recipe()
        input.character.triggerscript = [{
            type: 'output', conditions: [], lowLevelAccess: true,
            effect: [
                { type: 'stop' },
                { type: 'setvar', operator: '=', var: 'afterStop', value: 'ran' },
            ],
        }] as any

        const result = await executeRevenantOutputTriggers({
            recipe: input, chat: input.chat, text: 'answer',
        })
        expect(result.chat.scriptstate).toEqual({ $afterStop: 'ran' })
    })
})
