import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
    notifyError: vi.fn(),
    recoverRevenantTranslationJobs: vi.fn(async () => 0),
    requestChatData: vi.fn(),
}))

vi.mock('../storage/database.svelte', () => ({
    getDatabase: () => ({
        translatorType: 'llm',
        translator: 'ko',
        translatorInputLanguage: 'en',
        characters: [],
    }),
}))
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
    completeRevenantTranslation: vi.fn(),
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
        maxResponse: 1024,
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
    readPersistentJsonBatch: vi.fn(async () => new Map()),
    removePersistentKey: vi.fn(),
    writePersistentJson: vi.fn(),
}))

import { runTranslator } from './translator'

describe('LLM translation failure lifecycle', () => {
    beforeEach(() => {
        mocks.notifyError.mockClear()
        mocks.recoverRevenantTranslationJobs.mockClear()
        mocks.requestChatData.mockReset()
    })

    it('delegates failure cleanup to the shared retain-success policy', async () => {
        let requestArg: Record<string, any> | undefined
        mocks.requestChatData.mockImplementationOnce(async (arg) => {
            requestArg = arg
            arg.onRevenantJobCreated?.('failed-attempt-1')
            arg.onRevenantJobCreated?.('failed-attempt-2')
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
})
