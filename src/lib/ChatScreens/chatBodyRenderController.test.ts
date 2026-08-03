import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
    db: {
        translatorType: 'llm',
        legacyTranslation: true,
        translateBeforeHTMLFormatting: false,
    },
    getLLMCache: vi.fn(async () => null),
    translateHTML: vi.fn(),
}))

vi.mock('../../ts/stores.svelte', () => ({
    DBState: { db: mocks.db },
}))
vi.mock('../../ts/translator/translator', () => ({
    getLLMCache: mocks.getLLMCache,
    subscribeLLMTranslationCache: () => () => {},
    translateHTML: mocks.translateHTML,
}))
vi.mock('../../ts/parser/parser.svelte', () => ({
    ParseMarkdown: vi.fn(async (value: string) => value),
    postTranslationParse: (value: string) => value,
}))
vi.mock('../../ts/util', () => ({
    sleep: async () => {},
}))

import { createChatBodyRenderController } from './chatBodyRenderController.svelte'

function createDeferredTranslation() {
    let resolve!: (value: string) => void
    let signal: AbortSignal | undefined
    let taskCompleted = false
    const completion = new Promise<string>((done) => {
        resolve = done
    })
    mocks.translateHTML.mockImplementationOnce(async (
        _value: string,
        _reverse: boolean,
        _character: unknown,
        _chatId: number,
        _regenerate: boolean,
        taskSignal: AbortSignal,
    ) => {
        signal = taskSignal
        const result = await completion
        taskCompleted = true
        return result
    })
    return {
        resolve,
        getSignal: () => signal,
        isCompleted: () => taskCompleted,
    }
}

function renderTranslation(controller: ReturnType<typeof createChatBodyRenderController>) {
    return controller.renderTranslation({
        data: 'source',
        charArg: null,
        chatId: 0,
        retranslate: false,
        translationCacheKey: 'source',
        parseMarkdown: async value => value,
    })
}

describe('chat body translation task lifetime', () => {
    beforeEach(() => {
        mocks.db.translatorType = 'llm'
        mocks.db.legacyTranslation = true
        mocks.db.translateBeforeHTMLFormatting = false
        mocks.getLLMCache.mockResolvedValue(null)
        mocks.translateHTML.mockReset()
    })

    it('keeps an issued LLM translation alive when its chat body is disposed', async () => {
        const deferred = createDeferredTranslation()
        const controller = createChatBodyRenderController(() => {})
        const result = renderTranslation(controller)
        await vi.waitFor(() => expect(deferred.getSignal()).toBeDefined())

        controller.dispose()

        expect(deferred.getSignal()?.aborted).toBe(false)
        deferred.resolve('translated')
        await expect(result).rejects.toMatchObject({ name: 'AbortError' })
        expect(deferred.isCompleted()).toBe(true)
    })

    it('still aborts an LLM translation on explicit cancellation', async () => {
        const deferred = createDeferredTranslation()
        let cancel: (() => void) | null = null
        const controller = createChatBodyRenderController(
            () => {},
            nextCancel => cancel = nextCancel,
        )
        const result = renderTranslation(controller)
        await vi.waitFor(() => expect(cancel).not.toBeNull())

        cancel?.()

        expect(deferred.getSignal()?.aborted).toBe(true)
        deferred.resolve('translated')
        await result
        controller.dispose()
    })

    it('still aborts non-LLM translation work when its chat body is disposed', async () => {
        mocks.db.translatorType = 'google'
        const deferred = createDeferredTranslation()
        const controller = createChatBodyRenderController(() => {})
        const result = renderTranslation(controller)
        await vi.waitFor(() => expect(deferred.getSignal()).toBeDefined())

        controller.dispose()

        expect(deferred.getSignal()?.aborted).toBe(true)
        deferred.resolve('translated')
        await expect(result).rejects.toMatchObject({ name: 'AbortError' })
    })
})
