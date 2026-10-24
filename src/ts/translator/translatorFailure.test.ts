import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
    db: { translatorType: 'llm', translator: 'ko', translatorInputLanguage: 'en', characters: [] },
    notifyError: vi.fn(),
    recoverRevenantTranslationJobs: vi.fn(async () => 0),
    requestChatData: vi.fn(),
    completeRevenantTranslation: vi.fn(),
    readPersistentJsonBatch: vi.fn(async () => new Map()),
    writePersistentJson: vi.fn(),
}))

vi.mock('../storage/database.svelte', () => ({ getDatabase: () => mocks.db }))
vi.mock('../stores.svelte', () => ({
    selectedCharID: {
        subscribe(run: (value: number) => void) {
            run(0)
            return () => {}
        },
    },
}))
vi.mock('../alert', () => ({ notifyError: mocks.notifyError }))
vi.mock('../globalApi.svelte', () => ({ globalFetch: vi.fn() }))
vi.mock('../process/index.svelte', () => ({}))
vi.mock('../process/request/request', () => ({
    requestChatData: mocks.requestChatData,
}))
vi.mock('../process/revenant/recovery', () => ({
    completeRevenantTranslation: mocks.completeRevenantTranslation,
    decodeRevenantTranslation: (value: string) => value,
    isUsableTranslationResult: (value: string | null | undefined) => Boolean(value?.trim()),
    prepareRevenantTranslationRequest: (text: string) => ({
        cacheKey: text,
        requestText: text,
        styleDecodes: [],
        operationContext: {
            kind: 'translation',
            operationId: 'translation-operation',
            cacheKey: text,
            styleDecodes: [],
            replaceExisting: false,
            target: null,
        },
    }),
    recoverRevenantTranslationJobs: mocks.recoverRevenantTranslationJobs,
}))
vi.mock('./presets', () => ({
    defaultTranslatorPrompt: 'Translate {{slot::content}} to {{slot}}',
    getCurrentTranslatorPresetFromState: () => ({
        prompt: '',
    }),
}))
vi.mock('../parser/chatML', () => ({ parseChatML: () => null }))
vi.mock('../parser/parser.svelte', () => ({ applyMarkdownToNode: vi.fn() }))
vi.mock('../process/modules', () => ({ getModuleRegexScripts: () => [] }))
vi.mock('../process/scripts', () => ({ processScriptFull: vi.fn() }))
vi.mock('../util', () => ({ getNodetextToSentence: vi.fn() }))
vi.mock('../notificationSound', () => ({ playNotificationSound: vi.fn() }))
vi.mock('../storage/persistentKv', () => ({
    clearPersistentPrefix: vi.fn(),
    listPersistentKeys: vi.fn(async () => []),
    makeHashedStorageKey: vi.fn(async (_prefix: string, key: string) => key),
    readPersistentJson: vi.fn(async () => null),
    readPersistentJsonBatch: mocks.readPersistentJsonBatch,
    removePersistentKey: vi.fn(),
    writePersistentJson: mocks.writePersistentJson,
}))

import { getLLMCache, runPromptTranslator, runTranslator, translate, translateHTML, translateVox } from './translator'

describe('translation lifecycle', () => {
    beforeEach(() => {
        vi.clearAllMocks()
        mocks.db.translator = 'ko'
        mocks.requestChatData.mockReset()
        mocks.completeRevenantTranslation.mockReset()
        mocks.readPersistentJsonBatch.mockReset()
        mocks.readPersistentJsonBatch.mockResolvedValue(new Map())
    })

    it('skips model requests for empty HTML while still honoring cancellation', async () => {
        await expect(translateHTML('', false, '', -1)).resolves.toBe('')
        expect(mocks.requestChatData).not.toHaveBeenCalled()

        const controller = new AbortController()
        const reason = new Error('Cancelled')
        controller.abort(reason)
        await expect(translateHTML('', false, '', -1, false, controller.signal)).rejects.toBe(reason)
    })

    it('returns the source without model requests when the translator language is disabled', async () => {
        mocks.db.translator = ''
        await expect(translate('hello', false)).resolves.toBe('hello')
        await expect(translateHTML('<p>hello</p>', false, '', -1)).resolves.toBe('<p>hello</p>')
        await expect(runPromptTranslator('hello', {
            preset: { id: 'dialog', name: 'Dialog', prompt: 'Translate {{slot::content}}' },
            modelPresetId: 'model',
        })).resolves.toBe('hello')
        expect(mocks.requestChatData).not.toHaveBeenCalled()
    })

    it('still translates VOICEVOX speech to Japanese when the translator language is disabled', async () => {
        mocks.db.translator = ''
        mocks.requestChatData.mockResolvedValueOnce({ type: 'success', result: 'こんにちは' })
        mocks.completeRevenantTranslation.mockResolvedValueOnce('こんにちは')
        await expect(translateVox('hello')).resolves.toBe('こんにちは')
        expect(mocks.requestChatData).toHaveBeenCalledOnce()
    })

    it('delegates failure cleanup to the shared retain-success policy', async () => {
        let requestArg: Record<string, any> | undefined
        mocks.requestChatData.mockImplementationOnce(async (arg) => {
            requestArg = arg
            return {
                type: 'fail',
                noRetry: true,
                result: 'Requests ending with a model turn are not supported.',
            }
        })

        await expect(runTranslator('hello', false, 'ko', 'en')).resolves.toBe('hello')

        expect(requestArg?.revenantAuxiliaryResultPolicy).toBe('retain-success')
        expect(mocks.notifyError).toHaveBeenCalledWith(
            'Requests ending with a model turn are not supported.',
        )
    })

    it('does not read or write the translation cache for an ephemeral prompt translation', async () => {
        let requestArg: Record<string, any> | undefined
        mocks.requestChatData.mockImplementationOnce(async (arg) => {
            requestArg = arg
            return { type: 'success', result: 'translated' }
        })

        await expect(runPromptTranslator('hello', {
            preset: {
                id: 'dialog-preset',
                name: 'Dialog preset',
                prompt: 'Translate {{slot::content}}',
            },
            modelPresetId: 'model-preset',
            cache: false,
        })).resolves.toBe('translated')

        expect(mocks.recoverRevenantTranslationJobs).not.toHaveBeenCalled()
        expect(mocks.completeRevenantTranslation).not.toHaveBeenCalled()
        expect(requestArg?.revenantOperationContext).toBeUndefined()
        expect(requestArg?.revenantAuxiliaryResultPolicy).toBeUndefined()
        expect(mocks.readPersistentJsonBatch).not.toHaveBeenCalled()
        expect(mocks.writePersistentJson).not.toHaveBeenCalled()
    })

    it('falls back to the source when a successful request completes empty', async () => {
        mocks.requestChatData.mockResolvedValue({
            type: 'success',
            result: '',
        })
        mocks.completeRevenantTranslation.mockResolvedValue('   ')

        await expect(runTranslator('hello', false, 'ko', 'en')).resolves.toBe('hello')
        expect(mocks.notifyError).toHaveBeenCalledWith(
            'Translation returned an empty response.',
        )
    })

    it('treats a legacy empty persistent cache entry as a cache miss', async () => {
        mocks.readPersistentJsonBatch.mockResolvedValue(new Map([
            ['legacy-empty', { key: 'legacy-empty', value: '' }],
        ]))

        await expect(getLLMCache('legacy-empty')).resolves.toBeNull()
    })
})
