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
                setDescription(id, 'updated description')
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
        expect(triggered.mutations).toEqual({
            character: { desc: 'updated description' },
        })
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

    it('uses the snapshotted otherAx provider for Lua axLLM calls', async () => {
        const input = recipe('plugin') as any
        input.auxProviders = {
            otherAx: { backend: 'plugin', modelPreset: { id: 'ax-preset' } },
        }
        const waiting = await executeRevenantLua({
            code: `
                onOutput = async(function(id)
                    axLLM(id, {{ role = 'user', content = 'judge' }}):await()
                end)
            `,
            mode: 'output', data: '', recipe: input, chat: input.chat,
        })

        expect(waiting.action).toMatchObject({
            kind: 'provider.axllm',
            payload: {
                backend: 'plugin',
                modelPreset: { id: 'ax-preset' },
            },
        })
    })

    it('supports canonical character, chat, and local lorebook APIs', async () => {
        const input = recipe('http') as any
        input.character.firstMessage = 'first'
        input.character.backgroundHTML = 'old background'
        input.chat.note = 'author note'
        input.chat.localLore = []
        const result = await executeRevenantLua({
            code: `
                function onOutput(id)
                    setChatVar(id, 'first-before', getCharacterFirstMessage(id))
                    setChatVar(id, 'last-char', getCharacterLastMessage(id))
                    setChatVar(id, 'author-note', getAuthorsNote(id))
                    setCharacterFirstMessage(id, 'new first')
                    setBackgroundEmbedding(id, 'new background')
                    upsertLocalLoreBook(id, 'entry', 'content', {
                        alwaysActive = true, key = 'key', insertOrder = 12
                    })
                end
            `,
            mode: 'output', data: '', recipe: input, chat: input.chat,
        })

        expect(result.chat.scriptstate).toMatchObject({
            '$first-before': 'first',
            '$last-char': 'old',
            '$author-note': 'author note',
        })
        expect(result.chat.localLore).toEqual([expect.objectContaining({
            comment: 'entry', content: 'content', alwaysActive: true,
            key: 'key', insertorder: 12,
        })])
        expect(result.mutations).toEqual({
            character: {
                firstMessage: 'new first',
                backgroundHTML: 'new background',
            },
        })
    })

    it('suspends tokenization through a replayable utility action', async () => {
        const input = recipe('http')
        const code = `
            onOutput = async(function(id)
                local count = getTokens(id, 'hello world'):await()
                setChatVar(id, 'tokens', count)
            end)
        `
        const waiting = await executeRevenantLua({
            code, mode: 'output', data: '', recipe: input, chat: input.chat,
        })
        expect(waiting.action).toMatchObject({
            actionId: 'lua.utility.tokenize:0',
            kind: 'utility.tokenize',
            payload: { text: 'hello world' },
        })

        const completed = await executeRevenantLua({
            code,
            mode: 'output',
            data: '',
            recipe: input,
            chat: input.chat,
            responses: { 'lua.utility.tokenize:0': 2 },
        })
        expect(completed.chat.scriptstate).toEqual({ $tokens: '2' })
    })
})
