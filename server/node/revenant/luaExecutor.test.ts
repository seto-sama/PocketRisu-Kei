// @vitest-environment node
import { describe, expect, it } from 'vitest'
import executorPkg from './luaExecutor.cjs'

const { executeRevenantLua } = executorPkg as {
    executeRevenantLua: (options: any) => Promise<any>
}

function recipe(backend = 'http') {
    return {
        providerBackend: backend,
        modelPreset: { id: 'preset-1' },
        character: { name: 'Alice', lowLevelAccess: true },
        database: { username: 'Bob', globalChatVariables: {} },
        modules: [],
        chat: { id: 'room-1', message: [{ role: 'char', data: 'old' }] },
    }
}

describe('revenant headless Lua executor', () => {
    it('runs editOutput and output triggers once against an isolated chat', async () => {
        const code = `
            listenEdit('editOutput', function(id, value, meta) return value .. '-edited' end)
            function onOutput(id)
                setChatVar(id, 'mood', 'happy')
                addChat(id, 'char', 'triggered')
            end
        `
        const edited = await executeRevenantLua({
            code, mode: 'editOutput', data: 'answer', recipe: recipe(), chat: recipe().chat,
        })
        expect(edited).toMatchObject({ status: 'completed', data: 'answer-edited' })
        const triggered = await executeRevenantLua({
            code, mode: 'output', data: edited.data, recipe: recipe(), chat: edited.chat,
        })
        expect(triggered.chat.scriptstate).toEqual({ $mood: 'happy' })
        expect(triggered.chat.message.at(-1)).toMatchObject({ role: 'char', data: 'triggered' })
    })

    it('suspends plugin provider calls as a replayable client action', async () => {
        const code = `
            onOutput = async(function(id)
                local result = simpleLLM(id, 'dynamic prompt'):await()
                setChatVar(id, 'result', result.result)
            end)
        `
        const waiting = await executeRevenantLua({
            code, mode: 'output', data: '', recipe: recipe('plugin'), chat: recipe().chat,
        })
        expect(waiting).toMatchObject({
            status: 'waiting_client',
            action: {
                actionId: 'lua.provider.simplellm:0',
                kind: 'provider.simplellm',
                payload: { backend: 'plugin', prompt: 'dynamic prompt' },
            },
        })

        const completed = await executeRevenantLua({
            code,
            mode: 'output',
            data: '',
            recipe: recipe('plugin'),
            chat: recipe().chat,
            responses: { 'lua.provider.simplellm:0': { success: true, result: 'client result' } },
        })
        expect(completed.status).toBe('completed')
        expect(completed.chat.scriptstate).toEqual({ $result: 'client result' })
    })
})
