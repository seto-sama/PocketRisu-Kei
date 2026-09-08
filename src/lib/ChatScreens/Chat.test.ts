// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const storeMocks = vi.hoisted(() => {
    function writable<T>(initial: T) {
        let value = initial
        const subscribers = new Set<(value: T) => void>()
        return {
            subscribe(run: (value: T) => void) {
                subscribers.add(run)
                run(value)
                return () => subscribers.delete(run)
            },
            set(next: T) {
                value = next
                subscribers.forEach(run => run(value))
            },
            update(updater: (value: T) => T) {
                value = updater(value)
                subscribers.forEach(run => run(value))
            },
        }
    }

    const ReloadChatPointer = writable<Record<number, number>>({})
    return {
        DBState: { db: {} as any },
        createSimpleCharacter: (character: unknown) => character,
        ReloadChatPointer,
        invalidateChatMessageRender: (messageIndex: number) => {
            ReloadChatPointer.update(value => ({
                ...value,
                [messageIndex]: (value[messageIndex] ?? 0) + 1,
            }))
        },
        ReloadGUIPointer: writable(0),
        selectedCharID: writable(0),
        HideIconStore: writable(false),
        mdViewport: writable(true),
        CurrentTriggerIdStore: writable<string | null>(null),
        selIdState: { selId: 0 },
        popupStore: { openId: 0, children: null, mouseX: 0, mouseY: 0 },
    }
})

const parserMocks = vi.hoisted(() => ({
    ParseMarkdown: vi.fn(async (value: string) => value),
    imagePreloadingEnabled: false,
    preloadInlayAssets: vi.fn(() => Promise.resolve()),
    preloadInlayAssetsWhenNear: vi.fn(() => () => {}),
    preloadRenderedChatImages: vi.fn(() => Promise.resolve()),
    prepareMarkdownSource: vi.fn(async (value: string) => value),
    renderPreparedMarkdown: vi.fn(async (value: string) => value),
}))

const interactionMocks = vi.hoisted(() => ({
    runLuaButtonTrigger: vi.fn(),
    runTrigger: vi.fn(),
}))

const alertMocks = vi.hoisted(() => ({
    alertConfirmMulti: vi.fn(),
}))

const translatorMocks = vi.hoisted(() => ({
    copyLLMCache: vi.fn(async (_sourceKey: string, _targetKey: string) => false),
    getLLMCache: vi.fn(async (_key: string) => null as string | null),
    setLLMCache: vi.fn(async (_key: string, _value: string) => {}),
    translateHTML: vi.fn(async (
        value: string,
        _reverse?: boolean,
        _character?: unknown,
        _chatId?: number,
        _regenerate?: boolean,
        _signal?: AbortSignal,
    ) => value),
}))

vi.mock('src/ts/stores.svelte', () => storeMocks)
vi.mock('src/ts/gui/breakpoints', () => ({ mdViewport: storeMocks.mdViewport }))
vi.mock('src/ts/globalApi.svelte', () => ({
    aiLawApplies: () => false,
    changeChatTo: vi.fn(),
    chatFoldedStateMessageIndex: { index: -1 },
    createPersistedChatCopy: vi.fn(),
    foldChatToMessage: vi.fn(),
    getFileSrc: async (value: string) => value,
}))
vi.mock('src/ts/gui/colorscheme', () => ({ ColorSchemeTypeStore: storeMocks.HideIconStore }))
vi.mock('src/ts/model/modellist', () => ({ getModelInfo: () => ({ shortName: 'model' }) }))
vi.mock('src/ts/process/scriptings', () => ({ runLuaButtonTrigger: interactionMocks.runLuaButtonTrigger }))
vi.mock('src/ts/process/scripts', () => ({ risuChatParser: (value: string) => value }))
vi.mock('src/ts/process/triggers', () => ({ runTrigger: interactionMocks.runTrigger }))
vi.mock('src/ts/process/tts', () => ({ sayTTS: vi.fn() }))
vi.mock('src/ts/util', () => ({
    capitalize: (value: string) => value,
    getUserIcon: () => '',
    getUserName: () => 'User',
    sleep: async () => {},
}))
vi.mock('../../lang', () => ({
    language: new Proxy({ edit: 'Edit' }, {
        get(target, property: string) {
            return property in target ? target[property as keyof typeof target] : property
        },
    }),
}))
vi.mock('../../ts/alert', () => ({
    alertClear: vi.fn(),
    alertConfirm: vi.fn(),
    alertConfirmMulti: alertMocks.alertConfirmMulti,
    alertInput: vi.fn(),
    alertRequestData: vi.fn(),
    alertWait: vi.fn(),
    notifyInfo: vi.fn(),
    notifySuccess: vi.fn(),
    alertError: vi.fn(),
}))
vi.mock('../../ts/parser/parser.svelte', () => ({
    ParseMarkdown: parserMocks.ParseMarkdown,
    addMetadataToElement: (value: string) => value,
    getDistance: () => 0,
    isChatImagePreloadingEnabled: () => parserMocks.imagePreloadingEnabled,
    postTranslationParse: (value: string) => value,
    prepareMarkdownSource: parserMocks.prepareMarkdownSource,
    preloadInlayAssets: parserMocks.preloadInlayAssets,
    preloadInlayAssetsWhenNear: parserMocks.preloadInlayAssetsWhenNear,
    preloadRenderedChatImages: parserMocks.preloadRenderedChatImages,
    renderPreparedMarkdown: parserMocks.renderPreparedMarkdown,
    resolveInlayPlaceholders: vi.fn(() => () => {}),
    trimMarkdown: (value: string) => value,
}))
vi.mock('../../ts/translator/translator', () => ({
    copyLLMCache: translatorMocks.copyLLMCache,
    getLLMCache: translatorMocks.getLLMCache,
    getLLMTranslationCacheRevision: () => 0,
    setLLMCache: translatorMocks.setLLMCache,
    subscribeLLMTranslationCache: () => () => {},
    translateHTML: translatorMocks.translateHTML,
}))
vi.mock('../../ts/storage/database.svelte', () => ({
    getCurrentCharacter: () => storeMocks.DBState.db.characters[0],
    getCurrentChat: () => storeMocks.DBState.db.characters[0].chats[0],
    getStickyChatToolbarVariant: (theme: string) =>
        theme === '' ? 'footer' : theme === 'standardRisu' || theme === 'waifu' ? 'floating' : null,
    normalizeChat: (chat: unknown) => chat,
    setCurrentChat: vi.fn(),
}))
vi.mock('src/ts/process/modules', () => ({ getModuleAssets: () => [] }))
vi.mock('src/ts/imageGeneration/addInlayToCharacter', () => ({
    addGeneratedInlayToCharacter: vi.fn(),
    GeneratedInlayAssetError: class GeneratedInlayAssetError extends Error {},
}))
vi.mock('src/ts/characters', () => ({ getCharImage: (value: string) => value }))
vi.mock('src/ts/gui/longtouch', () => ({ longpress: () => ({ destroy() {} }) }))
vi.mock('src/ts/process/revenant/recovery', () => ({
    configureRevenantGenerationChatRecovery: () => {},
    createRevenantChatTranslationRecoveryContext: () => ({ trackSnapshot: () => {} }),
    createRevenantChatTranslationRecovery: () => ({
        pending: false,
        inspectionReady: true,
        capture: () => ({ pending: false, cacheKey: null }),
        shouldDisplayTranslation: async (
            snapshot: { cacheKey: string | null },
            options: {
                data: string
                translated: boolean
                streaming: boolean
                autoTranslationSuppressed?: boolean
                lastOutputAutoTranslationEligible?: boolean
                parseMarkdown: (data: string, mode: 'pretranslate') => Promise<string>
            },
        ) => {
            if (options.streaming || !options.data.trim()) return false
            if (!options.translated && options.autoTranslationSuppressed) return false
            const display = options.translated || Boolean(storeMocks.DBState.db.autoTranslate)
            if (!display) return false
            const lastOutputOnly = storeMocks.DBState.db.autoTranslateLastOutputOnly === true
            const cachedOnly = storeMocks.DBState.db.autoTranslateCachedOnly === true
                && storeMocks.DBState.db.translatorType === 'llm'
            if (!options.translated) {
                if (lastOutputOnly && options.lastOutputAutoTranslationEligible) return true
                if (lastOutputOnly && !cachedOnly) return false
            }
            const cacheKey = await options.parseMarkdown(options.data, 'pretranslate')
            snapshot.cacheKey = cacheKey
            if (
                cachedOnly
                && !options.translated
            ) return await translatorMocks.getLLMCache(cacheKey) !== null
            return true
        },
        waitForResult: async () => true,
        acknowledgeResolved: async () => {},
    }),
}))

import { mount, tick, unmount } from 'svelte'
import { createClassComponent } from 'svelte/legacy'
import Chat from './Chat.svelte'
import Chats from './Chats.svelte'
import ChatsTestHarness from './Chats.test-harness.svelte'
import { clearChatBodyRenderCache } from './chatBodyRenderCache'
import { DBState } from 'src/ts/stores.svelte'
import type { character, Message } from 'src/ts/storage/database.svelte'

const mountedComponents: unknown[] = []

beforeEach(() => {
    clearChatBodyRenderCache()
    parserMocks.imagePreloadingEnabled = false
    parserMocks.ParseMarkdown.mockImplementation(async (value: string) => value)
    parserMocks.preloadInlayAssets.mockResolvedValue()
    parserMocks.preloadRenderedChatImages.mockResolvedValue()
    parserMocks.prepareMarkdownSource.mockImplementation(async (value: string) => value)
    parserMocks.renderPreparedMarkdown.mockImplementation(
        async (value: string) => `<p>${value.trim()}</p>`,
    )
    translatorMocks.getLLMCache.mockResolvedValue(null)
    translatorMocks.copyLLMCache.mockImplementation(async (sourceKey: string, targetKey: string) => {
        const cached = await translatorMocks.getLLMCache(sourceKey)
        if (cached === null) return false
        if (sourceKey !== targetKey) await translatorMocks.setLLMCache(targetKey, cached)
        return true
    })
    translatorMocks.setLLMCache.mockImplementation(async (_key: string, _value: string) => {})
    translatorMocks.translateHTML.mockImplementation(async (value: string) => value)
    DBState.db = {
        theme: 'standardRisu',
        language: 'en',
        translator: '',
        translatorType: '',
        showPreviousChatSwipeButtons: false,
        useStreaming: false,
        zoomsize: 100,
        lineHeight: 1.25,
        characters: [{
            chatPage: 0,
            name: 'Character',
            chats: [{
                message: [{ role: 'user', data: 'User message', chatId: 'message-0' }],
                bookmarks: [],
            }],
        }],
    } as unknown as typeof DBState.db
})

afterEach(async () => {
    await Promise.all(mountedComponents.splice(0).map(component => unmount(component as never)))
    document.body.replaceChildren()
    vi.unstubAllGlobals()
    vi.clearAllMocks()
})

async function waitForParserCalls(expected: number) {
    const deadline = Date.now() + 2_000
    while (parserMocks.ParseMarkdown.mock.calls.length < expected && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 20))
    }
}

async function waitForTranslationButtonState(target: HTMLElement, active: boolean) {
    const deadline = Date.now() + 2_000
    while (Date.now() < deadline) {
        const button = target.querySelector<HTMLButtonElement>('.button-icon-translate')
        if (button?.classList.contains('text-primary') === active) {
            // Cache-state publication is intentionally deferred until after
            // the rendered HTML commits. Require the state to remain stable
            // so this catches a stale render cache undoing the user's click.
            await new Promise(resolve => setTimeout(resolve, 30))
            const settledButton = target.querySelector<HTMLButtonElement>('.button-icon-translate')
            if (settledButton?.classList.contains('text-primary') === active) return settledButton
        }
        await new Promise(resolve => setTimeout(resolve, 20))
    }
    return target.querySelector<HTMLButtonElement>('.button-icon-translate')
}

describe('Chat editing', () => {
    it('keeps user translation toggles while retaining cached room restores', async () => {
        DBState.db.translator = 'google'
        DBState.db.translatorType = 'google'

        const firstTarget = document.createElement('div')
        document.body.appendChild(firstTarget)
        const firstComponent = mount(Chat, {
            target: firstTarget,
            props: {
                message: 'User message',
                name: 'User',
                role: 'user',
                idx: 0,
                totalLength: 2,
                renderCacheKey: 'room:message',
            },
        })
        await waitForParserCalls(1)

        firstTarget.querySelector<HTMLButtonElement>('.button-icon-translate')?.click()
        const translatedButton = await waitForTranslationButtonState(firstTarget, true)
        expect(translatedButton?.classList.contains('text-primary')).toBe(true)

        translatedButton?.click()
        const originalButton = await waitForTranslationButtonState(firstTarget, false)
        expect(originalButton?.classList.contains('text-primary')).toBe(false)

        originalButton?.click()
        await waitForTranslationButtonState(firstTarget, true)
        await unmount(firstComponent)
        firstTarget.remove()

        parserMocks.ParseMarkdown.mockClear()
        const restoredTarget = document.createElement('div')
        document.body.appendChild(restoredTarget)
        const restoredComponent = mount(Chat, {
            target: restoredTarget,
            props: {
                message: 'User message',
                name: 'User',
                role: 'user',
                idx: 0,
                totalLength: 2,
                renderCacheKey: 'room:message',
            },
        })
        mountedComponents.push(restoredComponent)

        const restoredButton = await waitForTranslationButtonState(restoredTarget, true)
        expect(restoredButton?.classList.contains('text-primary')).toBe(true)
        expect(parserMocks.ParseMarkdown).not.toHaveBeenCalled()

        restoredButton?.click()
        const restoredOriginalButton = await waitForTranslationButtonState(restoredTarget, false)
        expect(restoredOriginalButton?.classList.contains('text-primary')).toBe(false)
    })

    it('reuses an LLM translation cache after showing the original text', async () => {
        DBState.db.translator = 'en'
        DBState.db.translatorType = 'llm'
        DBState.db.showTranslationLoading = true
        translatorMocks.getLLMCache.mockImplementation(async (key: string) =>
            key === 'User message' ? 'Cached translation' : null
        )
        translatorMocks.translateHTML.mockImplementation(async (key: string) =>
            await translatorMocks.getLLMCache(key) ?? `Translated ${key}`
        )

        const target = document.createElement('div')
        document.body.appendChild(target)
        const component = mount(Chat, {
            target,
            props: {
                message: 'User message',
                name: 'User',
                role: 'user',
                idx: 0,
                totalLength: 2,
                renderCacheKey: 'room:cached-message',
            },
        })
        mountedComponents.push(component)
        await waitForParserCalls(1)

        const originalButton = target.querySelector<HTMLButtonElement>('.button-icon-translate')
        originalButton?.click()
        const translatedButton = await waitForTranslationButtonState(target, true)
        await vi.waitFor(() => expect(translatorMocks.translateHTML).toHaveBeenCalled())
        await vi.waitFor(() => expect(target.textContent).toContain('Cached translation'))

        translatedButton?.click()
        const restoredOriginalButton = await waitForTranslationButtonState(target, false)
        await vi.waitFor(() => expect(target.textContent).toContain('User message'))

        restoredOriginalButton?.click()
        const restoredTranslatedButton = await waitForTranslationButtonState(target, true)
        await vi.waitFor(() => {
            expect(restoredTranslatedButton?.classList.contains('text-primary')).toBe(true)
            expect(target.textContent).toContain('Cached translation')
            expect(target.querySelector('.translating')).toBeNull()
        })
    })

    it('enters the original-message editor after one edit click', async () => {
        const target = document.createElement('div')
        document.body.appendChild(target)
        const component = mount(Chat, {
            target,
            props: {
                message: 'User message',
                name: 'User',
                role: 'user',
                idx: 0,
                totalLength: 2,
            },
        })
        mountedComponents.push(component)
        await tick()

        expect(target.querySelector('.message-edit-area')).toBeNull()
        target.querySelector<HTMLButtonElement>('.button-icon-edit')?.click()
        await tick()

        const editor = target.querySelector<HTMLTextAreaElement>('.message-edit-area')
        expect(editor).not.toBeNull()
        expect(editor?.value).toBe('User message')
        const editorField = editor?.closest('.risu-field-border')
        expect(editorField?.classList.contains('risu-local-stack')).toBe(true)
        expect(editorField?.classList.contains('risu-local-stack-focus')).toBe(true)
        expect(editorField?.classList.contains('z-20')).toBe(false)
        expect(editorField?.classList.contains('focus-within:z-40')).toBe(false)
        editor!.value = 'Edited user message'
        editor!.dispatchEvent(new Event('input', { bubbles: true }))
        await tick()
        target.querySelector<HTMLButtonElement>('.button-icon-edit')?.click()
        await tick()

        expect(DBState.db.characters[0].chats[0].message[0].data).toBe('Edited user message')
        expect(target.querySelector('.message-edit-area')).toBeNull()
    })

    it('locks controls only for the message owned by generation', async () => {
        const target = document.createElement('div')
        document.body.appendChild(target)
        const currentCharacter = {
            ...DBState.db.characters[0],
            chaId: 'character-1',
            image: 'character.png',
            largePortrait: false,
        } as unknown as character
        const messages: Message[] = [
            { role: 'char', data: 'previous', chatId: 'previous', swipes: ['one', 'two'], swipeId: 0, isRecovering: true },
            { role: 'user', data: 'question', chatId: 'question' },
            { role: 'char', data: 'streaming', chatId: 'generated' },
        ]
        currentCharacter.chats = [{ id: 'chat-1', message: messages } as any]
        DBState.db.characters[0] = currentCharacter

        const component = createClassComponent({
            component: ChatsTestHarness,
            target,
            props: {
                messages,
                currentCharacter,
                roomIsStreaming: true,
                roomIsResponding: true,
            },
        })
        await waitForParserCalls(3)

        const rendered = target.querySelectorAll('.chat-message-container')
        expect(rendered[0].querySelector<HTMLButtonElement>('.button-icon-edit')?.disabled).toBe(false)
        expect(rendered[2].querySelector<HTMLButtonElement>('.button-icon-edit')?.disabled).toBe(true)
        expect(rendered[2]
            .querySelector<HTMLButtonElement>('.button-icon-reroll')
            ?.closest('fieldset')?.disabled).toBe(true)

        rendered[0].querySelector<HTMLButtonElement>('.button-icon-edit')?.click()
        await vi.waitFor(() => {
            expect(rendered[0].querySelector<HTMLTextAreaElement>('.message-edit-area')?.value)
                .toBe('previous')
        })

        component.$destroy()
    })

    it('allows rerolling a historical image without enabling historical text swipes', async () => {
        const target = document.createElement('div')
        document.body.appendChild(target)
        const currentCharacter = {
            ...DBState.db.characters[0],
            chaId: 'character-1',
            image: 'character.png',
            largePortrait: false,
        } as unknown as character
        const messages: Message[] = [
            {
                role: 'char',
                data: '{{inlayed::image-1}}',
                kind: 'imageGeneration',
                chatId: 'image-message',
            },
            { role: 'char', data: 'historical text', chatId: 'historical-text' },
            { role: 'user', data: 'question', chatId: 'question' },
            { role: 'char', data: 'latest response', chatId: 'latest-response' },
        ]
        currentCharacter.chats = [{ id: 'chat-1', message: messages } as any]
        DBState.db.characters[0] = currentCharacter
        DBState.db.showPreviousChatSwipeButtons = false
        const onReroll = vi.fn()

        const component = createClassComponent({
            component: ChatsTestHarness,
            target,
            props: {
                messages,
                currentCharacter,
                onReroll,
            },
        })
        await waitForParserCalls(4)

        const rendered = target.querySelectorAll('.chat-message-container')
        expect(rendered[0].querySelectorAll('.button-icon-reroll').length).toBeGreaterThan(0)
        expect(rendered[1].querySelector('.button-icon-reroll')).toBeNull()

        const imageRerollButtons = rendered[0].querySelectorAll<HTMLButtonElement>('.button-icon-reroll')
        imageRerollButtons[imageRerollButtons.length - 1].click()
        await vi.waitFor(() => expect(onReroll).toHaveBeenCalledWith(0))

        component.$destroy()
    })

    it('locks the historical image that is currently rerolling', async () => {
        const target = document.createElement('div')
        document.body.appendChild(target)
        const currentCharacter = {
            ...DBState.db.characters[0],
            chaId: 'character-1',
            image: 'character.png',
            largePortrait: false,
        } as unknown as character
        const messages: Message[] = [
            {
                role: 'char',
                data: '{{inlayed::image-1}}',
                kind: 'imageGeneration',
                chatId: 'image-message',
            },
            { role: 'user', data: 'question', chatId: 'question' },
            { role: 'char', data: 'latest response', chatId: 'latest-response' },
        ]
        currentCharacter.chats = [{ id: 'chat-1', message: messages } as any]
        DBState.db.characters[0] = currentCharacter

        const component = createClassComponent({
            component: ChatsTestHarness,
            target,
            props: {
                messages,
                currentCharacter,
                imageRerollingMessageId: 'image-message',
            },
        })
        await waitForParserCalls(3)

        const rendered = target.querySelectorAll('.chat-message-container')
        expect(rendered[0]
            .querySelector<HTMLButtonElement>('.button-icon-reroll')
            ?.closest('fieldset')?.disabled).toBe(true)
        expect(rendered[2]
            .querySelector<HTMLButtonElement>('.button-icon-reroll')
            ?.closest('fieldset')?.disabled).toBe(false)

        component.$destroy()
    })

    it('keeps another message editable while an LLM translation is pending', async () => {
        DBState.db.translator = 'en'
        DBState.db.translatorType = 'llm'
        let finishTranslation!: () => void
        translatorMocks.translateHTML.mockImplementationOnce(async (value: string) => {
            await new Promise<void>(resolve => finishTranslation = resolve)
            return `Translated ${value}`
        })
        const messages: Message[] = [
            { role: 'user', data: 'First message', chatId: 'first-message' },
            { role: 'char', data: 'Second message', chatId: 'second-message' },
        ]
        const currentCharacter = {
            ...DBState.db.characters[0],
            chaId: 'character-1',
            image: 'character.png',
            largePortrait: false,
            chats: [{ id: 'chat-1', message: messages }],
        } as unknown as character
        DBState.db.characters[0] = currentCharacter

        const target = document.createElement('div')
        document.body.appendChild(target)
        const component = mount(Chats, {
            target,
            props: {
                messages,
                currentCharacter,
                chatRoomId: 'chat-1',
                onReroll: () => {},
                unReroll: () => {},
                currentUsername: 'User',
                userIcon: 'user.png',
                loadPages: 2,
            },
        })
        mountedComponents.push(component)
        await waitForParserCalls(2)

        const rendered = target.querySelectorAll('.chat-message-container')
        rendered[0].querySelector<HTMLButtonElement>('.button-icon-translate')?.click()
        await vi.waitFor(() => {
            expect(rendered[0].querySelector('.button-icon-translate')?.classList.contains('translating')).toBe(true)
        })

        const otherEditButton = rendered[1].querySelector<HTMLButtonElement>('.button-icon-edit')
        expect(otherEditButton?.disabled).toBe(false)
        otherEditButton?.click()
        await tick()
        expect(rendered[1].querySelector('.message-edit-area')).not.toBeNull()

        finishTranslation()
    })

    it('auto-translates only the last char message when its script differs from the UI language', async () => {
        DBState.db.language = 'ko'
        DBState.db.translator = 'ko'
        DBState.db.translatorType = 'llm'
        DBState.db.autoTranslate = true
        DBState.db.autoTranslateLastOutputOnly = true
        DBState.db.autoTranslateCachedOnly = false
        translatorMocks.translateHTML.mockImplementation(async (value: string) => `Translated ${value}`)

        const messages: Message[] = [
            { role: 'char', data: 'Older assistant output', chatId: 'older-output' },
            { role: 'char', data: 'Latest assistant output', chatId: 'latest-output' },
        ]
        const currentCharacter = {
            ...DBState.db.characters[0],
            chaId: 'character-1',
            image: 'character.png',
            largePortrait: false,
            chats: [{ id: 'chat-1', message: messages }],
        } as unknown as character
        DBState.db.characters[0] = currentCharacter

        const target = document.createElement('div')
        document.body.appendChild(target)
        const component = mount(Chats, {
            target,
            props: {
                messages,
                currentCharacter,
                chatRoomId: 'chat-1',
                onReroll: () => {},
                unReroll: () => {},
                currentUsername: 'User',
                userIcon: 'user.png',
                loadPages: 2,
            },
        })
        mountedComponents.push(component)

        await vi.waitFor(() => {
            expect(translatorMocks.translateHTML).toHaveBeenCalledWith(
                'Latest assistant output',
                false,
                expect.anything(),
                1,
                false,
                expect.any(AbortSignal),
            )
        })
        expect(translatorMocks.translateHTML.mock.calls.some(([value]) => value === 'Older assistant output'))
            .toBe(false)
    })

    it('judges last-output auto translation from the final displayed text', async () => {
        DBState.db.language = 'ko'
        DBState.db.translator = 'ko'
        DBState.db.translatorType = 'llm'
        DBState.db.autoTranslate = true
        DBState.db.autoTranslateLastOutputOnly = true
        DBState.db.autoTranslateCachedOnly = false

        const rawMessage = '☆ [Date: 2025-05-14 (Wed) | Location: Seoul | Weather: Sunny]\n안녕하세요.'
        parserMocks.ParseMarkdown.mockImplementation(async (value: string) => {
            if (value === rawMessage) {
                return '<p>안녕하세요. 오늘도 반가워요.</p>'
            }
            return value
        })

        const messages: Message[] = [
            { role: 'char', data: rawMessage, chatId: 'parsed-korean-output' },
        ]
        const currentCharacter = {
            ...DBState.db.characters[0],
            chaId: 'character-1',
            image: 'character.png',
            largePortrait: false,
            chats: [{ id: 'chat-1', message: messages }],
        } as unknown as character
        DBState.db.characters[0] = currentCharacter

        const target = document.createElement('div')
        document.body.appendChild(target)
        const component = mount(Chats, {
            target,
            props: {
                messages,
                currentCharacter,
                chatRoomId: 'chat-1',
                onReroll: () => {},
                unReroll: () => {},
                currentUsername: 'User',
                userIcon: 'user.png',
                loadPages: 1,
            },
        })
        mountedComponents.push(component)

        await vi.waitFor(() => expect(target.textContent).toContain('안녕하세요. 오늘도 반가워요.'))
        expect(translatorMocks.translateHTML).not.toHaveBeenCalled()
    })

    it('waits until streaming completes before evaluating last-output auto translation', async () => {
        DBState.db.language = 'ko'
        DBState.db.translator = 'ko'
        DBState.db.translatorType = 'llm'
        DBState.db.useStreaming = true
        DBState.db.autoTranslate = true
        DBState.db.autoTranslateLastOutputOnly = true
        DBState.db.autoTranslateCachedOnly = false
        translatorMocks.translateHTML.mockImplementation(async (value: string) => `Translated ${value}`)

        const streamingMessage: Message = {
            role: 'char',
            data: 'Streaming assistant output',
            chatId: 'streaming-output',
        }
        const currentCharacter = {
            ...DBState.db.characters[0],
            chaId: 'character-1',
            image: 'character.png',
            largePortrait: false,
            chats: [{ id: 'chat-1', message: [streamingMessage] }],
        } as unknown as character
        DBState.db.characters[0] = currentCharacter

        const target = document.createElement('div')
        document.body.appendChild(target)
        const component = createClassComponent({
            component: ChatsTestHarness,
            target,
            props: {
                messages: [streamingMessage],
                currentCharacter,
                roomIsStreaming: true,
                roomIsResponding: true,
            },
        })
        await vi.waitFor(() => expect(target.textContent).toContain('Streaming assistant output'))
        expect(translatorMocks.translateHTML).not.toHaveBeenCalled()

        component.$set({
            messages: [streamingMessage],
            roomIsStreaming: false,
            roomIsResponding: false,
        })
        await vi.waitFor(() => {
            expect(translatorMocks.translateHTML).toHaveBeenCalledWith(
                'Streaming assistant output',
                false,
                expect.anything(),
                0,
                false,
                expect.any(AbortSignal),
            )
        })
        component.$destroy()
    })

    it('does not restart auto translation after one explicit cancellation', async () => {
        DBState.db.translator = 'en'
        DBState.db.translatorType = 'llm'
        DBState.db.autoTranslate = true
        DBState.db.autoTranslateCachedOnly = false
        translatorMocks.translateHTML.mockImplementation(async (
            _value: string,
            _reverse?: boolean,
            _character?: unknown,
            _chatId?: number,
            _regenerate?: boolean,
            signal?: AbortSignal,
        ) => await new Promise<string>((_resolve, reject) => {
            signal?.addEventListener('abort', () => {
                reject(new DOMException('Aborted', 'AbortError'))
            }, { once: true })
        }))

        const target = document.createElement('div')
        document.body.appendChild(target)
        const component = mount(Chat, {
            target,
            props: {
                message: 'User message',
                name: 'User',
                role: 'user',
                idx: 0,
                totalLength: 2,
                renderCacheKey: 'room:auto-translation-cancel',
            },
        })
        mountedComponents.push(component)

        await vi.waitFor(() => {
            expect(target.querySelector('.button-icon-translate')?.classList.contains('translating'))
                .toBe(true)
        })
        target.querySelector<HTMLButtonElement>('.button-icon-translate')?.click()

        await vi.waitFor(() => {
            expect(target.querySelector<HTMLButtonElement>('.button-icon-translate')?.disabled)
                .toBe(false)
            expect(target.querySelector<HTMLButtonElement>('.button-icon-edit')?.disabled)
                .toBe(false)
        })
        await new Promise(resolve => setTimeout(resolve, 50))
        expect(translatorMocks.translateHTML).toHaveBeenCalledTimes(1)
    })

    it('reconciles completed translation markup when a background page resumes', async () => {
        let visibilityState: DocumentVisibilityState = 'hidden'
        const visibilitySpy = vi.spyOn(document, 'visibilityState', 'get')
            .mockImplementation(() => visibilityState)
        DBState.db.translator = 'en'
        DBState.db.translatorType = 'llm'
        let cached: string | null = null
        translatorMocks.getLLMCache.mockImplementation(async () => cached)
        translatorMocks.translateHTML.mockImplementation(async () => {
            cached = 'Translated user message'
            return cached
        })

        const target = document.createElement('div')
        document.body.appendChild(target)
        const component = mount(Chat, {
            target,
            props: {
                message: 'User message',
                name: 'User',
                role: 'user',
                idx: 0,
                totalLength: 2,
                renderCacheKey: 'room:resume-translation',
            },
        })
        mountedComponents.push(component)
        await waitForParserCalls(1)

        target.querySelector<HTMLButtonElement>('.button-icon-translate')?.click()
        await vi.waitFor(() => expect(target.textContent).toContain('Translated user message'))
        const parserCallsBeforeResume = parserMocks.ParseMarkdown.mock.calls.length

        visibilityState = 'visible'
        window.dispatchEvent(new Event('pageshow'))

        await vi.waitFor(() => {
            expect(parserMocks.ParseMarkdown.mock.calls.length).toBeGreaterThan(parserCallsBeforeResume)
        })
        visibilitySpy.mockRestore()
    })

    it('clears a stale resumed spinner when translation finished without a cache result', async () => {
        let visibilityState: DocumentVisibilityState = 'hidden'
        const visibilitySpy = vi.spyOn(document, 'visibilityState', 'get')
            .mockImplementation(() => visibilityState)
        DBState.db.translator = 'en'
        DBState.db.translatorType = 'llm'
        translatorMocks.getLLMCache.mockResolvedValue(null)
        translatorMocks.translateHTML.mockResolvedValue('Translated user message')

        const target = document.createElement('div')
        document.body.appendChild(target)
        const component = mount(Chat, {
            target,
            props: {
                message: 'User message',
                name: 'User',
                role: 'user',
                idx: 0,
                totalLength: 2,
                renderCacheKey: 'room:resume-empty-translation',
            },
        })
        mountedComponents.push(component)
        await waitForParserCalls(1)

        target.querySelector<HTMLButtonElement>('.button-icon-translate')?.click()
        await vi.waitFor(() => expect(target.textContent).toContain('Translated user message'))
        expect(target.querySelector('.button-icon-translate')?.classList.contains('text-primary')).toBe(true)

        visibilityState = 'visible'
        window.dispatchEvent(new Event('pageshow'))

        await vi.waitFor(() => {
            expect(target.querySelector('.button-icon-translate')?.classList.contains('text-primary')).toBe(false)
            expect(target.textContent).toContain('User message')
        })
        visibilitySpy.mockRestore()
    })

    it('uses the shared pencil button to edit the visible LLM translation', async () => {
        DBState.db.translator = 'en'
        DBState.db.translatorType = 'llm'
        translatorMocks.getLLMCache.mockResolvedValue('Translated user message')

        const target = document.createElement('div')
        document.body.appendChild(target)
        const component = mount(Chat, {
            target,
            props: {
                message: 'User message',
                name: 'User',
                role: 'user',
                idx: 0,
                totalLength: 2,
                renderCacheKey: 'room:translated-edit',
            },
        })
        mountedComponents.push(component)
        await waitForParserCalls(1)

        target.querySelector<HTMLButtonElement>('.button-icon-translate')?.click()
        await waitForTranslationButtonState(target, true)

        expect(target.querySelectorAll('.chat-generation-info button')).toHaveLength(1)
        const editButton = target.querySelector<HTMLButtonElement>('.button-icon-edit')
        expect(editButton?.getAttribute('aria-label')).toBe('editTranslation')
        editButton?.click()
        await vi.waitFor(() => {
            expect(target.querySelector('.message-edit-area')).not.toBeNull()
        })

        const editor = target.querySelector<HTMLTextAreaElement>('.message-edit-area')
        expect(editor?.value).toBe('Translated user message')
        editor!.value = 'Edited translation'
        editor!.dispatchEvent(new Event('input', { bubbles: true }))
        await tick()
        target.querySelector<HTMLButtonElement>('.button-icon-edit')?.click()
        await vi.waitFor(() => {
            expect(translatorMocks.setLLMCache).toHaveBeenCalledWith('User message', 'Edited translation')
            expect(target.querySelector('.message-edit-area')).toBeNull()
        })

        expect(DBState.db.characters[0].chats[0].message[0].data).toBe('User message')
    })

    it('opens the opposite LLM text editor from the pencil context menu', async () => {
        DBState.db.translator = 'en'
        DBState.db.translatorType = 'llm'
        translatorMocks.getLLMCache.mockResolvedValue('Translated user message')

        const target = document.createElement('div')
        document.body.appendChild(target)
        const component = mount(Chat, {
            target,
            props: {
                message: 'User message',
                name: 'User',
                role: 'user',
                idx: 0,
                totalLength: 2,
                renderCacheKey: 'room:opposite-edit',
            },
        })
        mountedComponents.push(component)
        await waitForParserCalls(1)

        const originalContextMenu = new MouseEvent('contextmenu', {
            bubbles: true,
            cancelable: true,
        })
        target.querySelector<HTMLButtonElement>('.button-icon-edit')?.dispatchEvent(originalContextMenu)
        expect(originalContextMenu.defaultPrevented).toBe(true)
        await vi.waitFor(() => {
            expect(target.querySelector<HTMLTextAreaElement>('.message-edit-area')?.value)
                .toBe('Translated user message')
        })

        target.querySelector<HTMLButtonElement>('.button-icon-edit')?.click()
        await vi.waitFor(() => expect(target.querySelector('.message-edit-area')).toBeNull())
        target.querySelector<HTMLButtonElement>('.button-icon-translate')?.click()
        await waitForTranslationButtonState(target, true)

        const translatedContextMenu = new MouseEvent('contextmenu', {
            bubbles: true,
            cancelable: true,
        })
        target.querySelector<HTMLButtonElement>('.button-icon-edit')?.dispatchEvent(translatedContextMenu)
        expect(translatedContextMenu.defaultPrevented).toBe(true)
        await vi.waitFor(() => {
            expect(target.querySelector<HTMLTextAreaElement>('.message-edit-area')?.value)
                .toBe('User message')
        })
    })

    it('moves the translation cache key while editing the translated original', async () => {
        DBState.db.translator = 'en'
        DBState.db.translatorType = 'llm'
        DBState.db.clickToEdit = true
        const cache = new Map([['User message', 'Translated user message']])
        translatorMocks.getLLMCache.mockImplementation(async (key: string) => cache.get(key) ?? null)
        translatorMocks.setLLMCache.mockImplementation(async (key: string, value: string) => {
            cache.set(key, value)
        })
        translatorMocks.translateHTML.mockImplementation(async (key: string) =>
            await translatorMocks.getLLMCache(key) ?? `Translated ${key}`
        )

        const target = document.createElement('div')
        document.body.appendChild(target)
        const component = mount(Chat, {
            target,
            props: {
                message: 'User message',
                name: 'User',
                role: 'user',
                idx: 0,
                totalLength: 2,
                renderCacheKey: 'room:linked-translation-edit',
            },
        })
        mountedComponents.push(component)
        await waitForParserCalls(1)

        target.querySelector<HTMLButtonElement>('.button-icon-translate')?.click()
        await waitForTranslationButtonState(target, true)
        target.querySelector<HTMLButtonElement>('.button-icon-translate')?.click()
        await waitForTranslationButtonState(target, false)
        target.querySelector<HTMLElement>('.text')?.click()

        await vi.waitFor(() => {
            expect(target.querySelector<HTMLTextAreaElement>('.message-edit-area')?.value).toBe('User message')
            expect(target.querySelector('.button-icon-keep-translation')?.textContent)
                .toContain('keepTranslation')
            expect(target.querySelector('[aria-label="retranslate"]')).toBeNull()
        })

        const keepTranslationButton = target.querySelector<HTMLButtonElement>(
            '.button-icon-keep-translation',
        )!
        expect(keepTranslationButton.classList.contains('text-primary')).toBe(true)

        const editor = target.querySelector<HTMLTextAreaElement>('.message-edit-area')!
        editor.value = 'Edited user message'
        editor.dispatchEvent(new Event('input', { bubbles: true }))
        await tick()
        target.querySelector<HTMLButtonElement>('.button-icon-edit')?.click()

        await vi.waitFor(() => {
            expect(translatorMocks.setLLMCache).toHaveBeenCalledWith(
                'Edited user message',
                'Translated user message',
            )
            expect(target.querySelector('.button-icon-translate')?.classList.contains('text-primary')).toBe(false)
            expect(target.textContent).toContain('Edited user message')
            expect(target.querySelector('[aria-label="retranslate"]')).toBeNull()
        })
        expect(DBState.db.characters[0].chats[0].message[0].data).toBe('Edited user message')

        target.querySelector<HTMLButtonElement>('.button-icon-translate')?.click()
        await waitForTranslationButtonState(target, true)
        expect(target.textContent).toContain('Translated user message')
        expect(target.querySelector('[aria-label="retranslate"]')).not.toBeNull()
    })

    it('keeps a translation edit scoped to its original swipe', async () => {
        DBState.db.translator = 'en'
        DBState.db.translatorType = 'llm'
        DBState.db.characters[0].chats[0].message[0] = {
            role: 'char',
            data: 'First swipe',
            chatId: 'message-0',
            swipes: ['First swipe', 'Second swipe'],
            swipeId: 0,
        }
        translatorMocks.getLLMCache.mockResolvedValue('Translated first swipe')
        const onNextSwipe = vi.fn()

        const target = document.createElement('div')
        document.body.appendChild(target)
        const component = mount(Chat, {
            target,
            props: {
                message: 'First swipe',
                name: 'Character',
                role: 'char',
                idx: 0,
                totalLength: 1,
                rerollIcon: true,
                currentPage: 1,
                totalPages: 2,
                onNextSwipe,
                renderCacheKey: 'room:swipe-edit',
            },
        })
        mountedComponents.push(component)
        await waitForParserCalls(1)

        target.querySelector<HTMLButtonElement>('.button-icon-translate')?.click()
        await waitForTranslationButtonState(target, true)
        target.querySelector<HTMLButtonElement>('.button-icon-edit')?.click()
        await vi.waitFor(() => {
            expect(target.querySelector('.message-edit-area')).not.toBeNull()
        })

        const editor = target.querySelector<HTMLTextAreaElement>('.message-edit-area')!
        editor.value = 'Edited first translation'
        editor.dispatchEvent(new Event('input', { bubbles: true }))
        await tick()

        const nextSwipeButton = target.querySelector<HTMLButtonElement>('.button-icon-reroll')!
        const translationButton = target.querySelector<HTMLButtonElement>('.button-icon-translate')!
        const retranslationButton = target.querySelector<HTMLButtonElement>('.chat-generation-info button')!
        expect(nextSwipeButton.closest('fieldset')?.disabled).toBe(true)
        expect(translationButton.disabled).toBe(true)
        expect(retranslationButton.disabled).toBe(true)
        nextSwipeButton.click()
        translationButton.click()
        expect(onNextSwipe).not.toHaveBeenCalled()
        expect(translationButton.classList.contains('text-primary')).toBe(true)

        // Even if the rendered source changes outside these controls, saving
        // must use the cache key captured when the editor was opened.
        parserMocks.ParseMarkdown.mockResolvedValue('Second swipe')
        target.querySelector<HTMLButtonElement>('.button-icon-edit')?.click()
        await vi.waitFor(() => {
            expect(translatorMocks.setLLMCache).toHaveBeenCalledWith(
                'First swipe',
                'Edited first translation',
            )
            expect(target.querySelector('.message-edit-area')).toBeNull()
        })
        expect(translatorMocks.setLLMCache).not.toHaveBeenCalledWith(
            'Second swipe',
            'Edited first translation',
        )
    })

    it('preserves the message anchor through a swipe DOM update', async () => {
        DBState.db.characters[0].chats[0].message[0] = {
            role: 'char',
            data: 'First swipe',
            chatId: 'message-0',
            swipes: ['First swipe', 'Second swipe'],
            swipeId: 0,
        }
        const release = vi.fn()
        const preserveElementPosition = vi.fn(() => release)
        const onNextSwipe = vi.fn()
        const target = document.createElement('div')
        document.body.appendChild(target)
        const component = mount(Chat, {
            target,
            props: {
                message: 'First swipe',
                name: 'Character',
                role: 'char',
                idx: 0,
                totalLength: 1,
                rerollIcon: true,
                currentPage: 1,
                totalPages: 2,
                onNextSwipe,
                getScrollController: () => ({ preserveElementPosition } as any),
            },
        })
        mountedComponents.push(component)
        await waitForParserCalls(1)

        target.querySelector<HTMLButtonElement>('.button-icon-reroll')?.click()

        await vi.waitFor(() => {
            expect(onNextSwipe).toHaveBeenCalledOnce()
            expect(preserveElementPosition).toHaveBeenCalledWith(
                target.querySelector('[data-chat-index="0"]'),
                { edge: 'bottom', followLayout: true },
            )
            expect(release).toHaveBeenCalledOnce()
        })
    })

    it('starts adjacent swipe preloading before the current render settles', async () => {
        let resolveParse: ((value: string) => void) | undefined
        parserMocks.ParseMarkdown.mockImplementationOnce(() => new Promise<string>((resolve) => {
            resolveParse = resolve
        }))
        const target = document.createElement('div')
        document.body.appendChild(target)
        const component = mount(Chat, {
            target,
            props: {
                message: '{{inlayed::current-image}}',
                name: 'Character',
                role: 'char',
                idx: 0,
                totalLength: 1,
                adjacentSwipeMessages: [
                    '{{inlayed::previous-image}}',
                    '{{inlayed::next-image}}',
                ],
            },
        })
        mountedComponents.push(component)

        await vi.waitFor(() => expect(resolveParse).toBeTypeOf('function'))
        expect(parserMocks.preloadInlayAssetsWhenNear).toHaveBeenCalledWith(
            expect.any(HTMLElement),
            [
                '{{inlayed::previous-image}}',
                '{{inlayed::next-image}}',
            ],
        )

        resolveParse?.('{{inlayed::current-image}}')
        await tick()
    })

    it('waits for inlay and rendered image preloads before committing a message', async () => {
        parserMocks.imagePreloadingEnabled = true
        let resolveInlays: (() => void) | undefined
        let resolveRenderedImages: (() => void) | undefined
        parserMocks.preloadInlayAssets.mockImplementationOnce(() => new Promise<void>((resolve) => {
            resolveInlays = resolve
        }))
        parserMocks.preloadRenderedChatImages.mockImplementationOnce(() => new Promise<void>((resolve) => {
            resolveRenderedImages = resolve
        }))

        const target = document.createElement('div')
        document.body.appendChild(target)
        const component = mount(Chat, {
            target,
            props: {
                message: '{{inlayed::delayed-image}} message body',
                name: 'Character',
                role: 'char',
                idx: 0,
                totalLength: 1,
            },
        })
        mountedComponents.push(component)

        await vi.waitFor(() => expect(resolveInlays).toBeTypeOf('function'))
        expect(parserMocks.ParseMarkdown).not.toHaveBeenCalled()
        expect(target.textContent).not.toContain('message body')

        resolveInlays?.()
        await vi.waitFor(() => expect(resolveRenderedImages).toBeTypeOf('function'))
        expect(parserMocks.ParseMarkdown).toHaveBeenCalled()
        expect(target.textContent).not.toContain('message body')

        resolveRenderedImages?.()
        await vi.waitFor(() => expect(target.textContent).toContain('message body'))
    })

    it('preserves the message anchor when translation is shown and hidden', async () => {
        DBState.db.translator = 'en'
        DBState.db.translatorType = 'llm'
        const release = vi.fn()
        const preserveElementPosition = vi.fn(() => release)
        const target = document.createElement('div')
        document.body.appendChild(target)
        const component = mount(Chat, {
            target,
            props: {
                message: 'Original output',
                name: 'Character',
                role: 'char',
                idx: 0,
                totalLength: 1,
                getScrollController: () => ({ preserveElementPosition } as any),
            },
        })
        mountedComponents.push(component)
        await waitForParserCalls(1)

        target.querySelector<HTMLButtonElement>('.button-icon-translate')!.click()
        await waitForTranslationButtonState(target, true)
        await vi.waitFor(() => expect(release).toHaveBeenCalledOnce())

        target.querySelector<HTMLButtonElement>('.button-icon-translate')!.click()
        await waitForTranslationButtonState(target, false)
        await vi.waitFor(() => expect(release).toHaveBeenCalledTimes(2))

        expect(preserveElementPosition).toHaveBeenCalledTimes(2)
        expect(preserveElementPosition).toHaveBeenLastCalledWith(
            target.querySelector('[data-chat-index="0"]'),
            { edge: 'bottom', followLayout: true },
        )
    })

    it('commits swipe and edit state in the originating message interaction', async () => {
        DBState.db.showPreviousChatSwipeButtons = true
        const messages: Message[] = [{
            role: 'char',
            data: 'A first swipe',
            chatId: 'message-a',
            swipes: ['A first swipe', 'A second swipe'],
            swipeId: 0,
        }, {
            role: 'char',
            data: 'B message',
            chatId: 'message-b',
        }]
        const currentCharacter = {
            ...DBState.db.characters[0],
            chaId: 'character-1',
            image: 'character.png',
            chats: [{ id: 'chat-1', message: messages }],
        } as unknown as character
        DBState.db.characters[0] = currentCharacter

        const target = document.createElement('div')
        document.body.appendChild(target)
        const component = mount(Chats, {
            target,
            props: {
                messages,
                currentCharacter,
                chatRoomId: 'chat-1',
                onReroll: () => {},
                onNextSwipe: (idx?: number) => {
                    const message = messages[idx ?? messages.length - 1]
                    message.swipeId = 1
                    message.data = message.swipes![1]
                    currentCharacter.reloadKeys = (currentCharacter.reloadKeys ?? 0) + 1
                    storeMocks.invalidateChatMessageRender(idx ?? messages.length - 1)
                },
                unReroll: () => {},
                currentUsername: 'User',
                userIcon: 'user.png',
                loadPages: 2,
            },
        })
        mountedComponents.push(component)
        await waitForParserCalls(2)

        const firstMessage = target.querySelectorAll<HTMLElement>('.chat-message-container')[0]
        const secondMessage = target.querySelectorAll<HTMLElement>('.chat-message-container')[1]
        firstMessage.querySelector<HTMLButtonElement>('.button-icon-reroll')!.click()

        // The originating event must publish both the parent-owned swipe and
        // the child-owned editor without requiring an event on message B.
        await tick()
        expect(firstMessage.textContent).toContain('2/2')
        expect(target.querySelectorAll<HTMLElement>('.chat-message-container')[1]).toBe(secondMessage)
        await waitForParserCalls(3)
        expect(parserMocks.ParseMarkdown).toHaveBeenCalledTimes(3)
        firstMessage.querySelector<HTMLButtonElement>('.button-icon-edit')!.click()
        await tick()
        expect(firstMessage.querySelector('.message-edit-area')).not.toBeNull()
    })

    it('allows navigating swipes on a context-disabled message', async () => {
        DBState.db.showPreviousChatSwipeButtons = true
        const messages: Message[] = [{
            role: 'char',
            data: 'Disabled first swipe',
            chatId: 'disabled-message',
            swipes: ['Disabled first swipe', 'Disabled second swipe'],
            swipeId: 0,
            disabled: true,
        }, {
            role: 'char',
            data: 'Current message',
            chatId: 'current-message',
        }]
        const currentCharacter = {
            ...DBState.db.characters[0],
            chaId: 'character-1',
            image: 'character.png',
            chats: [{ id: 'chat-1', message: messages }],
        } as unknown as character
        DBState.db.characters[0] = currentCharacter

        const target = document.createElement('div')
        document.body.appendChild(target)
        const component = mount(Chats, {
            target,
            props: {
                messages,
                currentCharacter,
                chatRoomId: 'chat-1',
                onReroll: () => {},
                onNextSwipe: (idx?: number) => {
                    const message = messages[idx ?? messages.length - 1]
                    message.swipeId = 1
                    message.data = message.swipes![1]
                    storeMocks.invalidateChatMessageRender(idx ?? messages.length - 1)
                },
                unReroll: () => {},
                currentUsername: 'User',
                userIcon: 'user.png',
                loadPages: 2,
            },
        })
        mountedComponents.push(component)
        await waitForParserCalls(2)

        const disabledMessage = target.querySelectorAll<HTMLElement>('.chat-message-container')[0]
        expect(disabledMessage.querySelectorAll('.button-icon-reroll')).toHaveLength(1)
        disabledMessage.querySelector<HTMLButtonElement>('.button-icon-reroll')!.click()

        await tick()
        expect(messages[0].data).toBe('Disabled second swipe')
        expect(messages[0].disabled).toBe(true)
        expect(disabledMessage.textContent).toContain('2/2')
    })

    it('restores a cached translation after deleting the selected swipe', async () => {
        DBState.db.translator = 'en'
        DBState.db.translatorType = 'llm'
        DBState.db.autoTranslate = true
        DBState.db.autoTranslateCachedOnly = true
        const messages: Message[] = [{
            role: 'char',
            data: 'Second swipe',
            chatId: 'message-0',
            swipes: ['First swipe', 'Second swipe'],
            swipeId: 1,
        }]
        const currentCharacter = {
            ...DBState.db.characters[0],
            chaId: 'character-1',
            image: 'character.png',
            largePortrait: false,
            chats: [{ id: 'chat-1', message: messages }],
        } as unknown as character
        DBState.db.characters[0] = currentCharacter
        translatorMocks.getLLMCache.mockImplementation(async (key: string) =>
            key === 'First swipe' ? 'Translated first swipe' : null
        )
        alertMocks.alertConfirmMulti.mockResolvedValue(0)

        const target = document.createElement('div')
        document.body.appendChild(target)
        const component = mount(Chats, {
            target,
            props: {
                messages,
                currentCharacter,
                chatRoomId: 'chat-1',
                onReroll: () => {},
                unReroll: () => {},
                onDeleteSwipe: () => {
                    const message = messages[0]
                    message.swipes!.splice(message.swipeId!, 1)
                    message.swipeId = 0
                    message.data = message.swipes![0]
                    delete message.swipes
                    delete message.swipeId
                    storeMocks.ReloadChatPointer.set({ 0: 1 })
                },
                currentUsername: 'User',
                userIcon: 'user.png',
                loadPages: 1,
            },
        })
        mountedComponents.push(component)
        await waitForParserCalls(1)
        expect(target.querySelector('.button-icon-translate')?.classList.contains('text-primary')).toBe(false)

        translatorMocks.getLLMCache.mockClear()
        target.querySelector<HTMLButtonElement>('.button-icon-remove')?.click()

        await vi.waitFor(() => {
            expect(messages[0].data).toBe('First swipe')
            expect(translatorMocks.getLLMCache).toHaveBeenCalledWith('First swipe')
            expect(target.querySelector('.button-icon-translate')?.classList.contains('text-primary')).toBe(true)
        })
    })

    it('restores the selected swipe cache after a remote canonical deletion', async () => {
        DBState.db.translator = 'en'
        DBState.db.translatorType = 'llm'
        DBState.db.autoTranslate = true
        DBState.db.autoTranslateCachedOnly = true
        const messages: Message[] = [{
            role: 'char',
            data: 'Third swipe',
            chatId: 'message-0',
            swipes: ['First swipe', 'Second swipe', 'Third swipe'],
            swipeId: 2,
        }]
        const currentCharacter = {
            ...DBState.db.characters[0],
            chaId: 'character-1',
            image: 'character.png',
            largePortrait: false,
            chats: [{ id: 'chat-1', message: messages }],
        } as unknown as character
        DBState.db.characters[0] = currentCharacter
        translatorMocks.getLLMCache.mockImplementation(async (key: string) =>
            key === 'Second swipe' ? 'Translated second swipe' : null
        )
        translatorMocks.translateHTML.mockImplementation(async (key: string) =>
            await translatorMocks.getLLMCache(key) ?? `Generated ${key}`
        )

        const target = document.createElement('div')
        document.body.appendChild(target)
        const component = mount(Chats, {
            target,
            props: {
                messages,
                currentCharacter,
                chatRoomId: 'chat-1',
                onReroll: () => {},
                unReroll: () => {},
                currentUsername: 'User',
                userIcon: 'user.png',
                loadPages: 1,
            },
        })
        mountedComponents.push(component)
        await waitForParserCalls(1)
        expect(target.querySelector('.button-icon-translate')?.classList.contains('text-primary')).toBe(false)

        messages[0].swipes!.splice(2, 1)
        messages[0].swipeId = 1
        messages[0].data = 'Second swipe'
        storeMocks.ReloadChatPointer.set({ 0: 1 })

        await vi.waitFor(() => {
            expect(translatorMocks.getLLMCache).toHaveBeenCalledWith('Second swipe')
            expect(target.querySelector('.button-icon-translate')?.classList.contains('text-primary')).toBe(true)
            expect(target.textContent).toContain('Translated second swipe')
        })
    })

    it('does not translate an uncached swipe selected by remote canonical sync', async () => {
        DBState.db.translator = 'en'
        DBState.db.translatorType = 'llm'
        const messages: Message[] = [{
            role: 'char',
            data: 'Second swipe',
            chatId: 'message-0',
            swipes: ['First swipe', 'Second swipe', 'Third swipe'],
            swipeId: 1,
        }]
        const currentCharacter = {
            ...DBState.db.characters[0],
            chaId: 'character-1',
            image: 'character.png',
            largePortrait: false,
            chats: [{ id: 'chat-1', message: messages }],
        } as unknown as character
        DBState.db.characters[0] = currentCharacter
        translatorMocks.getLLMCache.mockImplementation(async (key: string) =>
            key === 'Second swipe' ? 'Translated second swipe' : null
        )
        translatorMocks.translateHTML.mockImplementation(async (key: string) =>
            await translatorMocks.getLLMCache(key) ?? `Generated ${key}`
        )

        const target = document.createElement('div')
        document.body.appendChild(target)
        const component = mount(Chats, {
            target,
            props: {
                messages,
                currentCharacter,
                chatRoomId: 'chat-1',
                onReroll: () => {},
                unReroll: () => {},
                currentUsername: 'User',
                userIcon: 'user.png',
                loadPages: 1,
            },
        })
        mountedComponents.push(component)
        await waitForParserCalls(1)

        target.querySelector<HTMLButtonElement>('.button-icon-translate')?.click()
        await waitForTranslationButtonState(target, true)
        await vi.waitFor(() => expect(target.textContent).toContain('Translated second swipe'))
        translatorMocks.translateHTML.mockClear()

        messages[0].swipeId = 2
        messages[0].data = 'Third swipe'
        storeMocks.ReloadChatPointer.set({ 0: 2 })

        await vi.waitFor(() => {
            expect(target.querySelector('.button-icon-translate')?.classList.contains('text-primary')).toBe(false)
            expect(target.textContent).toContain('Third swipe')
        })
        expect(translatorMocks.translateHTML.mock.calls.some(
            ([source]) => source === 'Third swipe',
        )).toBe(false)
    })

    it('does not automatically retranslate content changed by an internal Lua button', async () => {
        const buttonMessage = '<button risu-btn="change-view">Change</button>'
        DBState.db.translator = 'en'
        DBState.db.translatorType = 'llm'
        DBState.db.characters[0].chaId = 'character-1'
        DBState.db.characters[0].chats[0].id = 'room-1'
        DBState.db.characters[0].chats[0].message[0].data = buttonMessage
        interactionMocks.runLuaButtonTrigger.mockImplementation(async () => {
            // Simulate CBS/Lua state becoming visible before the trigger
            // promise itself settles.
            storeMocks.ReloadGUIPointer.set(1)
            await Promise.resolve()
            return { chat: DBState.db.characters[0].chats[0] }
        })

        const target = document.createElement('div')
        document.body.appendChild(target)
        const component = mount(Chat, {
            target,
            props: {
                message: buttonMessage,
                name: 'User',
                role: 'user',
                idx: 0,
                totalLength: 2,
                renderCacheKey: 'room:lua-message',
            },
        })
        mountedComponents.push(component)
        await waitForParserCalls(1)

        target.querySelector<HTMLButtonElement>('.button-icon-translate')?.click()
        await waitForTranslationButtonState(target, true)
        expect(translatorMocks.translateHTML).toHaveBeenCalledTimes(1)

        target.querySelector<HTMLButtonElement>('[risu-btn="change-view"]')?.click()
        await vi.waitFor(() => {
            expect(interactionMocks.runLuaButtonTrigger).toHaveBeenCalledTimes(1)
            expect(target.querySelector('.button-icon-translate')?.classList.contains('text-primary')).toBe(false)
        })
        await new Promise(resolve => setTimeout(resolve, 30))

        expect(translatorMocks.translateHTML).toHaveBeenCalledTimes(1)
    })

    it.each(['standardRisu', 'waifu'])('groups sticky controls into a floating toolbar for the %s theme', async (theme) => {
        DBState.db.theme = theme
        DBState.db.stickyChatToolbar = true
        DBState.db.requestInfoInsideChat = true
        DBState.db.textScreenColor = '#345678'

        const target = document.createElement('div')
        document.body.appendChild(target)
        const component = mount(Chat, {
            target,
            props: {
                message: 'Long response',
                name: 'Character',
                role: 'char',
                idx: -1,
                firstMessage: true,
                messageGenerationInfo: { model: 'test-model' },
                totalLength: 1,
            },
        })
        mountedComponents.push(component)
        await tick()

        const floatingToolbar = target.querySelector('.chat-toolbar-sticky-layer')
        const floatingCard = floatingToolbar?.querySelector('.chat-toolbar-floating-card')
        expect(floatingToolbar).not.toBeNull()
        expect(floatingToolbar?.querySelector('.chat-generation-info')).not.toBeNull()
        expect(floatingToolbar?.querySelector('.chat-message-actions')).not.toBeNull()
        expect(floatingCard?.firstElementChild?.classList.contains('chat-toolbar-actions')).toBe(true)
        expect(floatingCard?.lastElementChild?.classList.contains('chat-toolbar-generation-info')).toBe(true)
        if (theme === 'waifu') {
            expect(floatingCard?.getAttribute('style')).toContain('#34567880')
        } else {
            expect(floatingCard?.getAttribute('style')).toContain('var(--risu-theme-lightbg)')
        }
    })

    it('keeps the floating toolbar to one row when model and translation details are absent', async () => {
        DBState.db.theme = 'waifu'
        DBState.db.stickyChatToolbar = true

        const target = document.createElement('div')
        document.body.appendChild(target)
        const component = mount(Chat, {
            target,
            props: {
                message: 'Response without details',
                name: 'Character',
                role: 'char',
                idx: -1,
                firstMessage: true,
                totalLength: 1,
            },
        })
        mountedComponents.push(component)
        await tick()

        const floatingCard = target.querySelector('.chat-toolbar-floating-card')
        expect(floatingCard?.children).toHaveLength(1)
        expect(floatingCard?.querySelector('.chat-toolbar-generation-info')).toBeNull()
    })

    it('shares one intersection observer and updates sticky state in both directions', async () => {
        let observerCallback: IntersectionObserverCallback | undefined
        const observe = vi.fn()
        const unobserve = vi.fn()
        const disconnect = vi.fn()
        const IntersectionObserverMock = vi.fn(function (callback: IntersectionObserverCallback) {
            observerCallback = callback
            return { observe, unobserve, disconnect }
        })
        vi.stubGlobal('IntersectionObserver', IntersectionObserverMock)

        DBState.db.theme = 'standardRisu'
        DBState.db.stickyChatToolbar = true
        const scrollRoot = document.createElement('div')
        scrollRoot.className = 'default-chat-screen'
        const firstTarget = document.createElement('div')
        const secondTarget = document.createElement('div')
        scrollRoot.append(firstTarget, secondTarget)
        document.body.appendChild(scrollRoot)

        const props = {
            message: 'Observed response',
            name: 'Character',
            role: 'char',
            idx: -1,
            firstMessage: true,
            totalLength: 1,
        }
        const firstComponent = mount(Chat, { target: firstTarget, props })
        const secondComponent = mount(Chat, { target: secondTarget, props })
        await tick()

        expect(IntersectionObserverMock).toHaveBeenCalledTimes(1)
        expect(observe).toHaveBeenCalledTimes(2)

        const firstAnchor = firstTarget.querySelector('.chat-toolbar-stick-anchor') as HTMLElement
        observerCallback?.([{
            target: firstAnchor,
            isIntersecting: true,
            boundingClientRect: { top: 10 },
        } as unknown as IntersectionObserverEntry], {} as IntersectionObserver)
        await tick()
        expect(firstTarget.querySelector('.chat-toolbar-sticky-layer')?.classList.contains('chat-toolbar-is-stuck')).toBe(false)

        observerCallback?.([{
            target: firstAnchor,
            isIntersecting: false,
            boundingClientRect: { top: -1 },
        } as unknown as IntersectionObserverEntry], {} as IntersectionObserver)
        await tick()
        expect(firstTarget.querySelector('.chat-toolbar-sticky-layer')?.classList.contains('chat-toolbar-is-stuck')).toBe(true)

        observerCallback?.([{
            target: firstAnchor,
            isIntersecting: true,
            boundingClientRect: { top: 10 },
        } as unknown as IntersectionObserverEntry], {} as IntersectionObserver)
        await tick()
        expect(firstTarget.querySelector('.chat-toolbar-sticky-layer')?.classList.contains('chat-toolbar-is-stuck')).toBe(false)

        await unmount(firstComponent)
        expect(unobserve).toHaveBeenCalledTimes(1)
        expect(disconnect).not.toHaveBeenCalled()
        await unmount(secondComponent)
        expect(unobserve).toHaveBeenCalledTimes(2)
        expect(disconnect).toHaveBeenCalledTimes(1)
    })

    it('keeps the complete PocketRisu Standard footer sticky at the bottom', async () => {
        DBState.db.theme = ''
        DBState.db.stickyChatToolbar = true
        DBState.db.fixedChatTextarea = true
        DBState.db.requestInfoInsideChat = true

        const target = document.createElement('div')
        document.body.appendChild(target)
        const component = mount(Chat, {
            target,
            props: {
                message: 'PocketRisu Standard response',
                name: 'Character',
                role: 'char',
                idx: -1,
                firstMessage: true,
                totalLength: 1,
            },
        })
        mountedComponents.push(component)
        await tick()

        const stickyFooter = target.querySelector('.chat-toolbar-sticky-footer')
        const stickyShell = target.querySelector('.chat-message-shell-sticky')
        expect(stickyShell).not.toBeNull()
        expect(stickyFooter).not.toBeNull()
        expect(stickyFooter?.querySelector('.chat-generation-info')).not.toBeNull()
        expect(stickyFooter?.querySelector('.chat-message-actions')).not.toBeNull()
        expect(stickyFooter?.classList.contains('chat-toolbar-floating-card')).toBe(false)
        const stickyFooterLayer = target.querySelector('.chat-message-body')?.nextElementSibling
        expect(stickyFooterLayer?.classList.contains('chat-toolbar-sticky-footer-layer')).toBe(true)
        expect(stickyFooterLayer?.classList.contains('chat-toolbar-above-fixed-composer')).toBe(true)
    })

    it('updates every non-final editor independently in a four-message blank chat', async () => {
        const messages: Message[] = [
            { role: 'user', data: '', chatId: 'message-0' },
            { role: 'char', data: '', chatId: 'message-1' },
            { role: 'user', data: '', chatId: 'message-2' },
            { role: 'char', data: '', chatId: 'message-3' },
        ]
        const currentCharacter = {
            ...DBState.db.characters[0],
            image: 'character.png',
            largePortrait: false,
            chats: [{ id: 'chat-1', message: messages }],
        } as unknown as character
        DBState.db.characters[0] = currentCharacter

        const target = document.createElement('div')
        document.body.appendChild(target)
        const component = mount(Chats, {
            target,
            props: {
                messages,
                currentCharacter,
                chatRoomId: 'chat-1',
                onReroll: () => {},
                unReroll: () => {},
                currentUsername: 'User',
                userIcon: 'user.png',
                loadPages: 4,
            },
        })
        mountedComponents.push(component)
        await tick()

        for (const index of [0, 1, 2]) {
            const message = target.querySelector<HTMLElement>(`[data-chat-index="${index}"]`)
            expect(message).not.toBeNull()
            message?.querySelector<HTMLButtonElement>('.button-icon-edit')?.click()
            await tick()
            expect(message?.querySelector('.message-edit-area')).not.toBeNull()
            expect(target.querySelector('[data-chat-index="3"] .message-edit-area')).toBeNull()
        }

        target.querySelector<HTMLButtonElement>('[data-chat-index="3"] .button-icon-edit')?.click()
        await tick()
        expect(target.querySelectorAll('.message-edit-area')).toHaveLength(4)
    })

    it('only parses newly loaded history while preserving an open editor', async () => {
        const messages: Message[] = Array.from({ length: 60 }, (_, index) => ({
            role: index % 2 === 0 ? 'user' : 'char',
            data: `Message ${index}`,
            chatId: `message-${index}`,
        }))
        const currentCharacter = {
            ...DBState.db.characters[0],
            image: 'character.png',
            largePortrait: false,
            chats: [{ id: 'chat-1', message: messages }],
        } as unknown as character
        DBState.db.characters[0] = currentCharacter

        const target = document.createElement('div')
        document.body.appendChild(target)
        const props = {
            messages,
            currentCharacter,
            chatRoomId: 'chat-1',
            onReroll: () => {},
            unReroll: () => {},
            currentUsername: 'User',
            userIcon: 'user.png',
            loadPages: 30,
        }
        const component = mount(Chats, {
            target,
            props,
        })
        mountedComponents.push(component)
        await tick()
        await waitForParserCalls(30)

        expect(target.querySelectorAll('.chat-message-container')).toHaveLength(30)
        expect(parserMocks.ParseMarkdown).toHaveBeenCalledTimes(30)
        expect(Array.from(target.querySelectorAll<HTMLElement>('[data-chat-index]'))
            .map(element => Number(element.dataset.chatIndex)))
            .toEqual(Array.from({ length: 30 }, (_, index) => index + 30))
        const editedMessage = target.querySelector<HTMLElement>('[data-chat-index="58"]')
        editedMessage?.querySelector<HTMLButtonElement>('.button-icon-edit')?.click()
        await tick()
        expect(editedMessage?.querySelector('.message-edit-area')).not.toBeNull()

        props.loadPages += 30
        storeMocks.ReloadChatPointer.set({})
        await tick()
        await waitForParserCalls(60)

        expect(target.querySelectorAll('.chat-message-container')).toHaveLength(60)
        expect(Array.from(target.querySelectorAll<HTMLElement>('[data-chat-index]'))
            .map(element => Number(element.dataset.chatIndex)))
            .toEqual(Array.from({ length: 60 }, (_, index) => index))
        expect(editedMessage?.querySelector('.message-edit-area')).not.toBeNull()
        expect(parserMocks.ParseMarkdown).toHaveBeenCalledTimes(60)
    })

    it('renders auto-translated history without an intermediate original parse', async () => {
        DBState.db.autoTranslate = true
        DBState.db.translatorType = 'llm'
        const messages: Message[] = Array.from({ length: 60 }, (_, index) => ({
            role: index % 2 === 0 ? 'user' : 'char',
            data: `Translated message ${index}`,
            chatId: `translated-message-${index}`,
        }))
        const currentCharacter = {
            ...DBState.db.characters[0],
            image: 'character.png',
            largePortrait: false,
            chats: [{ id: 'chat-1', message: messages }],
        } as unknown as character
        DBState.db.characters[0] = currentCharacter

        const target = document.createElement('div')
        document.body.appendChild(target)
        const component = mount(Chats, {
            target,
            props: {
                messages,
                currentCharacter,
                chatRoomId: 'chat-1',
                onReroll: () => {},
                unReroll: () => {},
                currentUsername: 'User',
                userIcon: 'user.png',
                loadPages: 30,
            },
        })
        mountedComponents.push(component)
        await tick()
        await waitForParserCalls(30)

        expect(target.querySelectorAll('.chat-message-container')).toHaveLength(30)
        expect(parserMocks.ParseMarkdown).toHaveBeenCalledTimes(30)
    })

    it('keeps stable streaming blocks mounted and performs a full final parse', async () => {
        DBState.db.useStreaming = true
        const initialMessage: Message = {
            role: 'char',
            data: 'Stable paragraph.\n\nTail',
            chatId: 'stream-1',
        }
        const currentCharacter = {
            ...DBState.db.characters[0],
            chaId: 'character-1',
            image: 'character.png',
            largePortrait: false,
            chats: [{ id: 'chat-1', message: [initialMessage] }],
        } as unknown as character
        DBState.db.characters[0] = currentCharacter

        const target = document.createElement('div')
        document.body.appendChild(target)
        const component = createClassComponent({
            component: ChatsTestHarness,
            target,
            props: {
                messages: [initialMessage],
                currentCharacter,
                roomIsStreaming: true,
                roomIsResponding: true,
            },
        })
        await vi.waitFor(() => {
            expect(target.textContent).toContain('Tail')
        })
        const stableParagraph = target.querySelector('p')
        expect(stableParagraph).not.toBeNull()

        const completedText = 'Stable paragraph.\n\nSecond paragraph.\n\nFinished tail'
        const growingMessage = { ...initialMessage, data: completedText }
        component.$set({
            messages: [growingMessage],
            roomIsStreaming: true,
            roomIsResponding: true,
        })
        await vi.waitFor(() => {
            expect(target.textContent).toContain('Finished tail')
        })

        expect(target.querySelector('p')).toBe(stableParagraph)
        expect(parserMocks.renderPreparedMarkdown.mock.calls
            .filter(([source]) => source === 'Stable paragraph.\n\n')).toHaveLength(1)

        component.$set({
            messages: [growingMessage],
            roomIsStreaming: false,
            roomIsResponding: false,
        })
        await vi.waitFor(() => {
            expect(parserMocks.ParseMarkdown).toHaveBeenCalledWith(
                completedText,
                expect.anything(),
                'notrim',
                0,
                expect.anything(),
                expect.anything(),
            )
        })
        component.$destroy()
    })

    it('keeps a completed streaming HTML image mounted while later tokens arrive', async () => {
        DBState.db.useStreaming = true
        parserMocks.renderPreparedMarkdown.mockImplementation(async (source: string) => source)
        const asset = '<style>.asset { display:block; }</style>\n'
            + '<div class="asset"><img src="asset.png"></div>\n'
        const initialMessage: Message = {
            role: 'char',
            data: `${asset}Later`,
            chatId: 'streaming-asset',
        }
        const currentCharacter = {
            ...DBState.db.characters[0],
            chaId: 'character-1',
            image: 'character.png',
            largePortrait: false,
            chats: [{ id: 'chat-1', message: [initialMessage] }],
        } as unknown as character
        DBState.db.characters[0] = currentCharacter

        const target = document.createElement('div')
        document.body.appendChild(target)
        const component = createClassComponent({
            component: ChatsTestHarness,
            target,
            props: {
                messages: [initialMessage],
                currentCharacter,
                roomIsStreaming: true,
                roomIsResponding: true,
            },
        })
        await vi.waitFor(() => expect(target.querySelector('.asset img')).not.toBeNull())
        const image = target.querySelector('.asset img')

        component.$set({
            messages: [{ ...initialMessage, data: `${asset}Later tokens` }],
            roomIsStreaming: true,
            roomIsResponding: true,
        })
        await vi.waitFor(() => expect(target.textContent).toContain('Later tokens'))

        expect(target.querySelector('.asset img')).toBe(image)
        component.$destroy()
    })

    it('publishes a new-message notification after a fast Echo response completes', async () => {
        DBState.db.autoScrollToNewMessage = false
        DBState.db.newMessageButtonStyle = 'bottom-center'
        const userMessage: Message = {
            role: 'user',
            data: 'User message',
            chatId: 'user-1',
        }
        const currentCharacter = {
            ...DBState.db.characters[0],
            chaId: 'character-1',
            image: 'character.png',
            largePortrait: false,
            chats: [{ id: 'chat-1', message: [userMessage] }],
        } as unknown as character
        DBState.db.characters[0] = currentCharacter

        const target = document.createElement('div')
        document.body.appendChild(target)
        const component = createClassComponent({
            component: ChatsTestHarness,
            target,
            props: {
                messages: [userMessage],
                currentCharacter,
                roomIsStreaming: false,
                roomIsResponding: false,
            },
        })
        const scrollHost = target.querySelector<HTMLElement>('.chat-test-scroll-host')!
        Object.defineProperties(scrollHost, {
            scrollHeight: { configurable: true, value: 1000 },
            clientHeight: { configurable: true, value: 200 },
        })
        scrollHost.scrollTop = 100

        const echoPlaceholder: Message = {
            role: 'char',
            data: '',
            chatId: 'echo-1',
        }
        component.$set({
            messages: [userMessage, echoPlaceholder],
            roomIsStreaming: true,
            roomIsResponding: true,
        })
        await tick()
        component.$set({
            messages: [userMessage, { ...echoPlaceholder, data: 'Echo Message' }],
            roomIsStreaming: false,
            roomIsResponding: true,
        })
        await tick()
        component.$set({
            messages: [userMessage, { ...echoPlaceholder, data: 'Echo Message' }],
            roomIsStreaming: false,
            roomIsResponding: false,
        })
        await tick()

        expect(target.querySelector('[data-new-message-state]')?.textContent).toBe('unread')
        component.$destroy()
    })
})
