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
    it('propagates Lua errors when no client action was requested', async () => {
        await expect(executeRevenantLua({
            code: "function onOutput(id) error('ordinary Lua failure') end",
            mode: 'output', data: '', recipe: recipe(), chat: recipe().chat,
        })).rejects.toThrow('ordinary Lua failure')
    })
    it('uses the shared mode dispatcher for input, start, and button callbacks', async () => {
        const code = `
            function onInput(id) setChatVar(id, 'mode', 'input') end
            function onStart(id) setChatVar(id, 'mode', 'start') end
            function onButtonClick(id, value) setChatVar(id, 'mode', value) end
        `
        const input = await executeRevenantLua({
            code, mode: 'input', data: '', recipe: recipe(), chat: recipe().chat,
        })
        const start = await executeRevenantLua({
            code, mode: 'start', data: '', recipe: recipe(), chat: recipe().chat,
        })
        const button = await executeRevenantLua({
            code, mode: 'onButtonClick', data: 'button', recipe: recipe(), chat: recipe().chat,
        })

        expect(input.chat.scriptstate).toEqual({ $mode: 'input' })
        expect(start.chat.scriptstate).toEqual({ $mode: 'start' })
        expect(button.chat.scriptstate).toEqual({ $mode: 'button' })
    })

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

    it('passes editDisplay as a raw string and ignores non-string listener results', async () => {
        const input = 'quoted "text"\n한글'
        const result = await executeRevenantLua({
            code: `
                listenEdit('editDisplay', function(id, value, meta)
                    return value .. ':' .. meta.index
                end)
                listenEdit('editDisplay', function() return { invalid = true } end)
            `,
            mode: 'editDisplay',
            data: input,
            meta: { index: 3 },
            recipe: recipe(),
            chat: recipe().chat,
        })

        expect(result).toMatchObject({ status: 'completed', data: `${input}:3` })
    })

    it('replays provider and similarity results as Lua tables without JS constructors', async () => {
        const code = `
            onOutput = async(function(id)
                local result = simpleLLM(id, 'dynamic prompt'):await()
                assert(type(result) == 'table')
                assert(result.constructor == nil)
                assert(result.success == true)
                setChatVar(id, 'result', result.result)
                local scores = similarity(id, 'query', {'first', 'second'}):await()
                assert(type(scores) == 'table' and scores.constructor == nil)
                local names = {}
                for _, score in ipairs(scores) do
                    assert(type(score) == 'table' and score.constructor == nil)
                    table.insert(names, score[1])
                end
                setChatVar(id, 'ranked', table.concat(names, ','))
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
            responses: {
                'lua.provider.simplellm:0': { success: true, result: 'client result' },
                'lua.utility.similarity-list:1': [['second', 0.9], ['first', 0.4]],
            },
        })
        expect(completed.status).toBe('completed')
        expect(completed.chat.scriptstate).toEqual({ $result: 'client result', $ranked: 'second,first' })
    })

    it('selects each snapshotted auxiliary provider mode from a real Lua axLLM call', async () => {
        const modes = ['memory', 'submodel', 'translate'] as const
        const input = recipe('plugin') as any
        input.auxProviders = Object.fromEntries(modes.map(mode => [mode, {
            backend: 'plugin', modelPreset: { id: `${mode}-preset` },
        }]))

        for (const mode of modes) {
            const waiting = await executeRevenantLua({
                code: `
                    onOutput = async(function(id)
                        axLLM(id, {{ role = 'user', content = 'judge' }}, false, { mode = '${mode}' })
                    end)
                `,
                mode: 'output', data: '', recipe: input, chat: input.chat,
            })

            expect(waiting.action).toMatchObject({
                kind: 'provider.axllm',
                payload: {
                    backend: 'plugin',
                    modelPreset: { id: `${mode}-preset` },
                    mode,
                },
            })
        }
    })

    it('uses the default otherAx mode when axLLM options omit mode', async () => {
        const input = recipe('plugin') as any
        input.auxProviders = {
            otherAx: { backend: 'plugin', modelPreset: { id: 'default-ax-preset' } },
        }
        const waiting = await executeRevenantLua({
            code: `
                onOutput = async(function(id)
                    axLLM(id, {{ role = 'user', content = 'judge' }})
                end)
            `,
            mode: 'output', data: '', recipe: input, chat: input.chat,
        })

        expect(waiting.action).toMatchObject({
            kind: 'provider.axllm',
            payload: {
                backend: 'plugin',
                modelPreset: { id: 'default-ax-preset' },
                mode: 'otherAx',
                prompt: [{ role: 'user', content: 'judge' }],
                useMultimodal: false,
                options: {},
            },
        })
    })

    it('returns Lua failure envelopes for invalid modes and missing auxiliary snapshots', async () => {
        const runAndReadError = async (options: any) => {
            const result = await executeRevenantLua({
                code: `
                    onOutput = async(function(id)
                        local response = axLLM(id, {{ role = 'user', content = 'judge' }}, false, ${options})
                        setChatVar(id, 'success', tostring(response.success))
                        setChatVar(id, 'result', response.result)
                    end)
                `,
                mode: 'output', data: '', recipe: recipe('plugin'), chat: recipe().chat,
            })
            expect(result.status).toBe('completed')
            expect(result.chat.scriptstate.$success).toBe('false')
            return result.chat.scriptstate.$result
        }

        await expect(runAndReadError("{ mode = 'invalid' }")).resolves.toBe(
            'Error: Invalid axLLM mode: invalid',
        )
        await expect(runAndReadError("{ mode = 'memory' }")).resolves.toBe(
            'Error: No auxiliary provider is configured for mode: memory',
        )
    })

    it('prefers a module provider snapshot over the selected auxiliary provider', async () => {
        const input = recipe('plugin') as any
        input.auxProviders = {
            memory: { backend: 'plugin', modelPreset: { id: 'memory-preset' } },
        }
        input.moduleProviders = {
            'module-1': { backend: 'plugin', modelPreset: { id: 'module-preset' } },
        }
        const waiting = await executeRevenantLua({
            code: `
                onOutput = async(function(id)
                    axLLM(id, {{ role = 'user', content = 'judge' }}, false, { mode = 'memory' })
                end)
            `,
            mode: 'output', data: '', recipe: input, chat: input.chat,
            moduleId: 'module-1',
        })

        expect(waiting.action).toMatchObject({
            kind: 'provider.axllm',
            payload: {
                mode: 'memory',
                backend: 'plugin',
                modelPreset: { id: 'module-preset' },
            },
        })
    })

    it('retains the selected mode across a normal action replay', async () => {
        const input = recipe('plugin') as any
        input.auxProviders = {
            memory: { backend: 'plugin', modelPreset: { id: 'memory-preset' } },
        }
        const code = `
            onOutput = async(function(id)
                local response = axLLM(id, {{ role = 'user', content = 'judge' }}, false, { mode = 'memory' })
                setChatVar(id, 'result', response.result)
            end)
        `
        const waiting = await executeRevenantLua({
            code, mode: 'output', data: '', recipe: input, chat: input.chat,
        })
        const replayed = await executeRevenantLua({
            code, mode: 'output', data: '', recipe: input, chat: input.chat,
            responses: {
                [waiting.action.actionId]: { success: true, result: 'memory reply' },
            },
        })

        expect(waiting.action.payload.mode).toBe('memory')
        expect(replayed.status).toBe('completed')
        expect(replayed.chat.scriptstate.$result).toBe('memory reply')
    })

    it.each([
        ['unset', undefined],
        ['portrait', 'portrait'],
        ['landscape', 'landscape'],
    ] as const)('forwards %s orientation from a real Lua generateImage call', async (_name, orientation) => {
        const options = orientation ? `, { orientation = '${orientation}' }` : ''
        const waiting = await executeRevenantLua({
            code: `
                onOutput = async(function(id)
                    generateImage(id, 'prompt', 'negative'${options}):await()
                end)
            `,
            mode: 'output', data: '', recipe: recipe(), chat: recipe().chat,
        })
        const expectedPayload: Record<string, unknown> = {
            prompt: 'prompt', negativePrompt: 'negative',
        }
        if (orientation) expectedPayload.orientation = orientation

        expect(waiting.action).toMatchObject({
            kind: 'image.generate', payload: expectedPayload,
        })
    })

    it('returns a Lua error for an invalid generateImage orientation without creating an action', async () => {
        const result = await executeRevenantLua({
            code: `
                onOutput = async(function(id)
                    local response = generateImage(id, 'prompt', 'negative', { orientation = 'diagonal' }):await()
                    setChatVar(id, 'image-error', response)
                end)
            `,
            mode: 'output', data: '', recipe: recipe(), chat: recipe().chat,
        })

        expect(result.status).toBe('completed')
        expect(result.chat.scriptstate['$image-error']).toBe('Error: Image orientation must be landscape or portrait, received diagonal')
        expect(result.action).toBeUndefined()
    })

    it('preserves a replayable client action when Lua pcall catches its suspension', async () => {
        const input = recipe('plugin') as any
        input.auxProviders = {
            otherAx: { backend: 'plugin', modelPreset: { id: 'ax-preset' } },
        }
        const code = `
            onOutput = async(function(id)
                local result
                local ok, err = pcall(function()
                    result = axLLM(id, {{ role = 'user', content = 'status' }})
                end)
                if ok then
                    setChatVar(id, 'result', result.result)
                else
                    log('caught: ' .. tostring(err))
                end
            end)
        `

        const waiting = await executeRevenantLua({
            code, mode: 'output', data: '', recipe: input, chat: input.chat,
        })
        expect(waiting).toMatchObject({
            status: 'waiting_client',
            action: {
                actionId: 'lua.provider.axllm:0',
                kind: 'provider.axllm',
            },
        })

        const completed = await executeRevenantLua({
            code,
            mode: 'output',
            data: '',
            recipe: input,
            chat: input.chat,
            responses: {
                'lua.provider.axllm:0': { success: true, result: 'generated status' },
            },
        })
        expect(completed.status).toBe('completed')
        expect(completed.chat.scriptstate).toEqual({ $result: 'generated status' })
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
