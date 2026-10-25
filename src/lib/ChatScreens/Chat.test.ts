// @vitest-environment happy-dom
import { requestImmediateSave } from '../../ts/globalApi.svelte'
import { getChatPage, setChatPage } from '../../ts/storage/chatSelection.svelte'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const storeMocks = await vi.hoisted(async () => {
    const { writable } = await import('svelte/store')
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
    preloadInlayAssetsWhenNear: vi.fn((_element: HTMLElement, _sources: string[]) => () => {}),
    preloadRenderedChatImages: vi.fn(() => Promise.resolve()),
    prepareMarkdownSource: vi.fn(async (value: string) => value),
    renderPreparedMarkdown: vi.fn(async (value: string) => value),
}))

const interactionMocks = vi.hoisted(() => ({
    runLuaInteractionTrigger: vi.fn(),
    runTrigger: vi.fn(),
}))

const alertMocks = vi.hoisted(() => ({
    alertConfirmMulti: vi.fn(),
}))

const translatorMocks = vi.hoisted(() => ({
    cacheRevision: 0,
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
    requestImmediateSave: vi.fn(async () => {}),
    aiLawApplies: () => false,
    changeChatTo: vi.fn(),
    chatFoldedStateMessageIndex: { index: -1 },
    createPersistedChatCopy: vi.fn(),
    foldChatToMessage: vi.fn(),
    getFileSrc: async (value: string) => value,
}))
vi.mock('src/ts/gui/colorscheme', () => ({ ColorSchemeTypeStore: storeMocks.HideIconStore }))
vi.mock('src/ts/process/scriptings', () => ({ runLuaInteractionTrigger: interactionMocks.runLuaInteractionTrigger }))
vi.mock('src/ts/process/scripts', () => ({ risuChatParser: (value: string) => value }))
vi.mock('src/ts/process/triggers', () => ({ runTrigger: interactionMocks.runTrigger }))
vi.mock('src/ts/process/tts', () => ({ sayTTS: vi.fn() }))
vi.mock('src/ts/util', () => ({
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
    getLLMTranslationCacheRevision: () => translatorMocks.cacheRevision,
    setLLMCache: translatorMocks.setLLMCache,
    subscribeLLMTranslationCache: () => () => {},
    translateHTML: translatorMocks.translateHTML,
}))
vi.mock('../../ts/storage/database.svelte', () => ({
    getDatabase: () => storeMocks.DBState.db,
    getCurrentCharacter: () => storeMocks.DBState.db.characters[0],
    getCurrentChat: () => { const character = storeMocks.DBState.db.characters[0]; return character.chats[getChatPage(character)] },
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

import { mount, tick, unmount, type ComponentProps } from 'svelte'
import { createClassComponent } from 'svelte/legacy'
import Chat from './Chat.svelte'
import Chats from './Chats.svelte'
import { clearChatBodyRenderCache } from './chatBodyRenderCache'
import { DBState } from 'src/ts/stores.svelte'
import type { character, Message } from 'src/ts/storage/database.svelte'

const componentCleanups: (() => void | Promise<void>)[] = []

beforeEach(() => {
    clearChatBodyRenderCache()
    storeMocks.ReloadChatPointer.set({})
    storeMocks.ReloadGUIPointer.set(0)
    parserMocks.imagePreloadingEnabled = false
    parserMocks.ParseMarkdown.mockImplementation(async (value: string) => value)
    parserMocks.preloadInlayAssets.mockResolvedValue()
    parserMocks.preloadRenderedChatImages.mockResolvedValue()
    parserMocks.prepareMarkdownSource.mockImplementation(async (value: string) => value)
    parserMocks.renderPreparedMarkdown.mockImplementation(
        async (value: string) => `<p>${value.trim()}</p>`,
    )
    translatorMocks.cacheRevision = 0
    translatorMocks.getLLMCache.mockResolvedValue(null)
    translatorMocks.copyLLMCache.mockResolvedValue(false)
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
            name: 'Character',
            chats: [{
                message: [{ role: 'user', data: 'User message', chatId: 'message-0' }],
                bookmarks: [],
            }],
        }],
    } as unknown as typeof DBState.db
})

afterEach(async () => {
    await Promise.all(componentCleanups.splice(0).map(cleanup => cleanup()))
    document.body.replaceChildren()
    vi.unstubAllGlobals()
    vi.clearAllMocks()
})

function setMessages(messages: Message[]) {
    const currentCharacter = {
        ...DBState.db.characters[0],
        chaId: 'character-1',
        image: 'character.png',
        largePortrait: false,
        chats: [{ id: 'chat-1', message: messages }],
    } as unknown as character
    DBState.db.characters[0] = currentCharacter
}

function mountChat(props: Partial<ComponentProps<typeof Chat>> = {}) {
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
            ...props,
        },
    })
    componentCleanups.push(() => unmount(component))
    return { target, component }
}

function mountChats(messages: Message[], props: Partial<ComponentProps<typeof Chats>> = {}) {
    const target = document.createElement('div')
    document.body.appendChild(target)
    const component = createClassComponent({
        component: Chats,
        target,
        props: {
            messages,
            currentCharacter: DBState.db.characters[0] as character,
            chatRoomId: 'chat-1',
            onReroll: () => {},
            unReroll: () => {},
            currentUsername: 'User',
            userIcon: 'user.png',
            loadPages: 30,
            ...props,
        },
    })
    componentCleanups.push(() => component.$destroy())
    return { target, component }
}

async function waitForText(target: Element, text: string, hidden?: string) {
    await vi.waitFor(() => {
        expect(target.textContent).toContain(text)
        if (hidden) expect(target.textContent).not.toContain(hidden)
    })
}

describe('Chat editing', () => {
    it('shows the stored model name as text only when request information is enabled', async () => {
        const model = 'pluginmodel:::my <model> & preset'
        const renderChat = (requestInfoInsideChat: boolean) => {
            DBState.db.requestInfoInsideChat = requestInfoInsideChat
            const { target } = mountChat({
                message: 'AI response',
                name: 'Character',
                role: 'char',
                idx: -1,
                firstMessage: true,
                messageGenerationInfo: { model },
                totalLength: 1,
            })
            return target
        }

        const disabledTarget = renderChat(false)
        await tick()
        expect(disabledTarget.querySelector(`.chat-generation-info button[aria-label="${model}"]`)).toBeNull()

        const enabledTarget = renderChat(true)
        await tick()
        const infoButton = enabledTarget.querySelector(`.chat-generation-info button[aria-label="${model}"]`)
        expect(infoButton?.textContent).toContain(model)
        expect(infoButton?.querySelector('model')).toBeNull()
    })

    it('keeps user translation toggles while retaining cached room restores', async () => {
        DBState.db.translator = 'google'
        DBState.db.translatorType = 'google'
        translatorMocks.translateHTML.mockResolvedValue('Google translation')
        const { target: firstTarget, component } = mountChat({ renderCacheKey: 'room:message' })
        await waitForText(firstTarget, 'User message')

        firstTarget.querySelector<HTMLButtonElement>('.button-icon-translate')!.click()
        await waitForText(firstTarget, 'Google translation', 'User message')
        firstTarget.querySelector<HTMLButtonElement>('.button-icon-translate')!.click()
        await waitForText(firstTarget, 'User message', 'Google translation')
        firstTarget.querySelector<HTMLButtonElement>('.button-icon-translate')!.click()
        await waitForText(firstTarget, 'Google translation', 'User message')
        await unmount(component)
        componentCleanups.pop()
        firstTarget.remove()

        const { target } = mountChat({ renderCacheKey: 'room:message' })
        await waitForText(target, 'Google translation')
        const translateButton = target.querySelector<HTMLButtonElement>('.button-icon-translate')!
        expect(translateButton.disabled).toBe(false)
        translateButton.click()
        await waitForText(target, 'User message', 'Google translation')
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
        const { target } = mountChat({ renderCacheKey: 'room:cached-message' })
        await waitForText(target, 'User message')

        target.querySelector<HTMLButtonElement>('.button-icon-translate')!.click()
        await waitForText(target, 'Cached translation', 'User message')
        target.querySelector<HTMLButtonElement>('.button-icon-translate')!.click()
        await waitForText(target, 'User message', 'Cached translation')
        target.querySelector<HTMLButtonElement>('.button-icon-translate')!.click()
        await waitForText(target, 'Cached translation', 'User message')
        expect(target.querySelector<HTMLButtonElement>('.button-icon-translate')?.disabled).toBe(false)
        expect(target.querySelector<HTMLButtonElement>('.button-icon-edit')?.disabled).toBe(false)
    })

    it('enters the original-message editor after one edit click', async () => {
        const { target } = mountChat()
        await tick()

        expect(target.querySelector('.message-edit-area')).toBeNull()
        target.querySelector<HTMLButtonElement>('.button-icon-edit')?.click()
        await tick()

        const editor = target.querySelector<HTMLTextAreaElement>('.message-edit-area')
        expect(editor).not.toBeNull()
        expect(editor?.value).toBe('User message')
        editor!.value = 'Edited user message'
        editor!.dispatchEvent(new Event('input', { bubbles: true }))
        await tick()
        target.querySelector<HTMLButtonElement>('.button-icon-edit')?.click()
        await tick()

        expect(DBState.db.characters[0].chats[0].message[0].data).toBe('Edited user message')
        expect(target.querySelector('.message-edit-area')).toBeNull()
    })

    it('locks controls only for the message owned by generation', async () => {
        const messages: Message[] = [
            { role: 'char', data: 'previous', chatId: 'previous', swipes: ['one', 'two'], swipeId: 0, isRecovering: true },
            { role: 'user', data: 'question', chatId: 'question' },
            { role: 'char', data: 'streaming', chatId: 'generated' },
        ]
        setMessages(messages)

        const { target } = mountChats(messages, {
            roomIsStreaming: true,
            roomIsResponding: true,
        })
        await waitForText(target, 'question')

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
    })

    it('allows rerolling a historical image without enabling historical text swipes', async () => {
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
        setMessages(messages)
        DBState.db.showPreviousChatSwipeButtons = false
        const onReroll = vi.fn()

        const { target } = mountChats(messages, {
            onReroll,
        })
        await waitForText(target, 'latest response')

        const rendered = target.querySelectorAll('.chat-message-container')
        expect(rendered[1].querySelector('.button-icon-reroll')).toBeNull()

        const imageRerollButtons = rendered[0].querySelectorAll<HTMLButtonElement>('.button-icon-reroll')
        imageRerollButtons[imageRerollButtons.length - 1].click()
        await vi.waitFor(() => expect(onReroll).toHaveBeenCalledWith(0))
    })

    it('locks the historical image that is currently rerolling', async () => {
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
        setMessages(messages)

        const { target } = mountChats(messages, {
            imageRerollingMessageId: 'image-message',
        })
        await waitForText(target, 'latest response')

        const rendered = target.querySelectorAll('.chat-message-container')
        expect(rendered[0]
            .querySelector<HTMLButtonElement>('.button-icon-reroll')
            ?.closest('fieldset')?.disabled).toBe(true)
        expect(rendered[2]
            .querySelector<HTMLButtonElement>('.button-icon-reroll')
            ?.closest('fieldset')?.disabled).toBe(false)
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
        setMessages(messages)

        const { target } = mountChats(messages, {
            loadPages: 2,
        })
        await waitForText(target, 'Second message')

        const rendered = target.querySelectorAll('.chat-message-container')
        rendered[0].querySelector<HTMLButtonElement>('.button-icon-translate')?.click()
        await vi.waitFor(() => expect(finishTranslation).toBeTypeOf('function'))

        const otherEditButton = rendered[1].querySelector<HTMLButtonElement>('.button-icon-edit')
        expect(otherEditButton?.disabled).toBe(false)
        otherEditButton?.click()
        await tick()
        expect(rendered[1].querySelector<HTMLTextAreaElement>('.message-edit-area')?.value).toBe('Second message')

        finishTranslation()
        await waitForText(rendered[0], 'Translated First message')
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
        setMessages(messages)

        const { target } = mountChats(messages, {
            loadPages: 2,
        })

        await waitForText(target, 'Translated Latest assistant output')
        expect(target.querySelector('[data-chat-index="0"]')?.textContent).toContain('Older assistant output')
        expect(target.querySelector('[data-chat-index="0"]')?.textContent).not.toContain('Translated')
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
        setMessages(messages)

        const { target } = mountChats(messages, {
            loadPages: 1,
        })

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
        setMessages([streamingMessage])

        const { target, component } = mountChats([streamingMessage], {
            roomIsStreaming: true,
            roomIsResponding: true,
        })
        await vi.waitFor(() => expect(target.textContent).toContain('Streaming assistant output'))
        expect(translatorMocks.translateHTML).not.toHaveBeenCalled()

        component.$set({
            messages: [streamingMessage],
            roomIsStreaming: false,
            roomIsResponding: false,
        })
        await waitForText(target, 'Translated Streaming assistant output')
    })

    it('does not restart auto translation after one explicit cancellation', async () => {
        DBState.db.translator = 'en'
        DBState.db.translatorType = 'llm'
        DBState.db.autoTranslate = true
        DBState.db.autoTranslateCachedOnly = false
        let translationSignal: AbortSignal | undefined
        translatorMocks.translateHTML.mockImplementationOnce(async (
            _value: string,
            _reverse?: boolean,
            _character?: unknown,
            _chatId?: number,
            _regenerate?: boolean,
            signal?: AbortSignal,
        ) => await new Promise<string>((_resolve, reject) => {
            translationSignal = signal
            signal?.addEventListener('abort', () => {
                reject(new DOMException('Aborted', 'AbortError'))
            }, { once: true })
        }))
        const { target } = mountChat({ renderCacheKey: 'room:auto-translation-cancel' })
        await vi.waitFor(() => expect(target.querySelector('[aria-label="cancel"]')).not.toBeNull())
        translatorMocks.translateHTML.mockClear()
        target.querySelector<HTMLButtonElement>('[aria-label="cancel"]')!.click()

        await vi.waitFor(() => {
            expect(translationSignal?.aborted).toBe(true)
            expect(target.querySelector<HTMLButtonElement>('.button-icon-translate')?.disabled).toBe(false)
            expect(target.querySelector<HTMLButtonElement>('.button-icon-edit')?.disabled).toBe(false)
        })
        await waitForText(target, 'User message')
        window.dispatchEvent(new Event('pageshow'))
        target.querySelector<HTMLButtonElement>('.button-icon-edit')!.click()
        await tick()
        expect(target.querySelector<HTMLTextAreaElement>('.message-edit-area')?.value).toBe('User message')
        expect(translatorMocks.translateHTML).not.toHaveBeenCalled()
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
            cached ??= 'Translated user message'
            return cached
        })

        const { target } = mountChat({
            renderCacheKey: 'room:resume-translation',
        })
        await waitForText(target, 'User message')

        target.querySelector<HTMLButtonElement>('.button-icon-translate')?.click()
        await waitForText(target, 'Translated user message')
        cached = 'Fresh background translation'
        translatorMocks.cacheRevision += 1

        visibilityState = 'visible'
        window.dispatchEvent(new Event('pageshow'))

        await waitForText(target, 'Fresh background translation')
        target.querySelector<HTMLButtonElement>('.button-icon-translate')!.click()
        await waitForText(target, 'User message')
        expect(target.querySelector<HTMLButtonElement>('.button-icon-edit')?.disabled).toBe(false)
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

        const { target } = mountChat({
            renderCacheKey: 'room:resume-empty-translation',
        })
        await waitForText(target, 'User message')

        target.querySelector<HTMLButtonElement>('.button-icon-translate')?.click()
        await vi.waitFor(() => expect(target.textContent).toContain('Translated user message'))

        visibilityState = 'visible'
        window.dispatchEvent(new Event('pageshow'))

        await vi.waitFor(() => {
            expect(target.querySelector<HTMLButtonElement>('.button-icon-translate')?.disabled).toBe(false)
            expect(target.querySelector<HTMLButtonElement>('.button-icon-edit')?.disabled).toBe(false)
            expect(target.textContent).toContain('User message')
        })
        target.querySelector<HTMLButtonElement>('.button-icon-edit')!.click()
        await tick()
        expect(target.querySelector<HTMLTextAreaElement>('.message-edit-area')?.value).toBe('User message')
        visibilitySpy.mockRestore()
    })

    it('uses the shared pencil button to edit the visible LLM translation', async () => {
        DBState.db.translator = 'en'
        DBState.db.translatorType = 'llm'
        let cached = 'Translated user message'
        translatorMocks.getLLMCache.mockImplementation(async () => cached)
        translatorMocks.translateHTML.mockImplementation(async () => cached)
        translatorMocks.setLLMCache.mockImplementation(async (_key: string, value: string) => { cached = value })

        const { target } = mountChat({
            renderCacheKey: 'room:translated-edit',
        })
        await waitForText(target, 'User message')

        target.querySelector<HTMLButtonElement>('.button-icon-translate')?.click()
        await waitForText(target, 'Translated user message')

        const editButton = target.querySelector<HTMLButtonElement>('.button-icon-edit')
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

        target.querySelector<HTMLButtonElement>('.button-icon-edit')!.click()
        await vi.waitFor(() => {
            expect(target.querySelector<HTMLTextAreaElement>('.message-edit-area')?.value).toBe('Edited translation')
        })
        expect(DBState.db.characters[0].chats[0].message[0].data).toBe('User message')
    })

    it('opens the opposite LLM text editor from the pencil context menu', async () => {
        DBState.db.translator = 'en'
        DBState.db.translatorType = 'llm'
        translatorMocks.getLLMCache.mockResolvedValue('Translated user message')
        translatorMocks.translateHTML.mockResolvedValue('Translated user message')

        const { target } = mountChat({
            renderCacheKey: 'room:opposite-edit',
        })
        await waitForText(target, 'User message')

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
        await waitForText(target, 'Translated user message')

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
        translatorMocks.copyLLMCache.mockImplementation(async (sourceKey: string, targetKey: string) => {
            const cached = cache.get(sourceKey)
            if (cached === undefined) return false
            cache.set(targetKey, cached)
            return true
        })
        translatorMocks.translateHTML.mockImplementation(async (key: string) =>
            await translatorMocks.getLLMCache(key) ?? `Translated ${key}`
        )

        const { target } = mountChat({
            renderCacheKey: 'room:linked-translation-edit',
        })
        await waitForText(target, 'User message')

        target.querySelector<HTMLButtonElement>('.button-icon-translate')?.click()
        await waitForText(target, 'Translated user message')
        target.querySelector<HTMLButtonElement>('.button-icon-translate')?.click()
        await waitForText(target, 'User message')
        target.querySelector<HTMLElement>('.text')?.click()

        await vi.waitFor(() => {
            expect(target.querySelector<HTMLTextAreaElement>('.message-edit-area')?.value).toBe('User message')
        })

        const editor = target.querySelector<HTMLTextAreaElement>('.message-edit-area')!
        editor.value = 'Edited user message'
        editor.dispatchEvent(new Event('input', { bubbles: true }))
        await tick()
        target.querySelector<HTMLButtonElement>('.button-icon-edit')?.click()

        await vi.waitFor(() => {
            expect(translatorMocks.copyLLMCache).toHaveBeenCalledWith('User message', 'Edited user message')
            expect(target.textContent).toContain('Edited user message')
        })
        expect(DBState.db.characters[0].chats[0].message[0].data).toBe('Edited user message')

        target.querySelector<HTMLButtonElement>('.button-icon-translate')?.click()
        await waitForText(target, 'Translated user message')
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
        translatorMocks.translateHTML.mockResolvedValue('Translated first swipe')
        const onNextSwipe = vi.fn()

        const { target } = mountChat({
            message: 'First swipe',
            name: 'Character',
            role: 'char',
            totalLength: 1,
            rerollIcon: true,
            currentPage: 1,
            totalPages: 2,
            onNextSwipe,
            renderCacheKey: 'room:swipe-edit',
        })
        await waitForText(target, 'First swipe')

        target.querySelector<HTMLButtonElement>('.button-icon-translate')?.click()
        await waitForText(target, 'Translated first swipe')
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
        expect(nextSwipeButton.closest('fieldset')?.disabled).toBe(true)
        expect(translationButton.disabled).toBe(true)
        nextSwipeButton.click()
        translationButton.click()
        expect(onNextSwipe).not.toHaveBeenCalled()
        expect(editor.value).toBe('Edited first translation')
        expect(DBState.db.characters[0].chats[0].message[0].data).toBe('First swipe')

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
        expect(DBState.db.characters[0].chats[0].message[0].data).toBe('First swipe')
    })

    it('starts adjacent swipe preloading before the current render settles', async () => {
        let resolveParse: ((value: string) => void) | undefined
        parserMocks.ParseMarkdown.mockImplementationOnce(() => new Promise<string>((resolve) => {
            resolveParse = resolve
        }))
        const { target } = mountChat({
            message: '{{inlayed::current-image}}',
            name: 'Character',
            role: 'char',
            totalLength: 1,
            adjacentSwipeMessages: ['{{inlayed::next-image}}'],
        })

        await vi.waitFor(() => expect(resolveParse).toBeTypeOf('function'))
        expect(parserMocks.preloadInlayAssetsWhenNear.mock.calls.some(
            ([, sources]) => sources.includes('{{inlayed::next-image}}'),
        )).toBe(true)
        expect(target.textContent).not.toContain('{{inlayed::current-image}}')

        resolveParse?.('{{inlayed::current-image}}')
        await waitForText(target, '{{inlayed::current-image}}')
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

        const { target } = mountChat({
            message: '{{inlayed::delayed-image}} message body',
            name: 'Character',
            role: 'char',
            totalLength: 1,
        })

        await vi.waitFor(() => expect(resolveInlays).toBeTypeOf('function'))
        expect(target.textContent).not.toContain('message body')

        resolveInlays?.()
        await vi.waitFor(() => expect(resolveRenderedImages).toBeTypeOf('function'))
        expect(target.textContent).not.toContain('message body')

        resolveRenderedImages?.()
        await vi.waitFor(() => expect(target.textContent).toContain('message body'))
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
        setMessages(messages)

        const { target } = mountChats(messages, {
            onNextSwipe: (idx?: number) => {
                const message = messages[idx ?? messages.length - 1]
                message.swipeId = 1
                message.data = message.swipes![1]
                storeMocks.invalidateChatMessageRender(idx ?? messages.length - 1)
            },
            loadPages: 2,
        })
        await waitForText(target, 'Disabled first swipe')

        const disabledMessage = target.querySelectorAll<HTMLElement>('.chat-message-container')[0]
        disabledMessage.querySelector<HTMLButtonElement>('.button-icon-reroll')!.click()

        await tick()
        expect(messages[0].data).toBe('Disabled second swipe')
        expect(messages[0].disabled).toBe(true)
        await waitForText(disabledMessage, 'Disabled second swipe')
        expect(disabledMessage.textContent).toContain('2/2')
        disabledMessage.querySelector<HTMLButtonElement>('.button-icon-edit')!.click()
        await tick()
        expect(disabledMessage.querySelector<HTMLTextAreaElement>('.message-edit-area')?.value)
            .toBe('Disabled second swipe')
        expect(target.querySelector('[data-chat-index="1"] .message-edit-area')).toBeNull()
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
        setMessages(messages)
        translatorMocks.getLLMCache.mockImplementation(async (key: string) =>
            key === 'First swipe' ? 'Translated first swipe' : null
        )
        translatorMocks.translateHTML.mockImplementation(async (key: string) =>
            await translatorMocks.getLLMCache(key) ?? `Generated ${key}`
        )
        alertMocks.alertConfirmMulti.mockResolvedValue(0)

        const { target } = mountChats(messages, {
            onDeleteSwipe: () => {
                const message = messages[0]
                message.swipes!.splice(message.swipeId!, 1)
                message.swipeId = 0
                message.data = message.swipes![0]
                delete message.swipes
                delete message.swipeId
                storeMocks.ReloadChatPointer.set({ 0: 1 })
            },
            loadPages: 1,
        })
        await waitForText(target, 'Second swipe')

        target.querySelector<HTMLButtonElement>('.button-icon-remove')?.click()

        await vi.waitFor(() => {
            expect(messages[0].data).toBe('First swipe')
            expect(target.textContent).toContain('Translated first swipe')
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
        setMessages(messages)
        translatorMocks.getLLMCache.mockImplementation(async (key: string) =>
            key === 'Second swipe' ? 'Translated second swipe' : null
        )
        translatorMocks.translateHTML.mockImplementation(async (key: string) =>
            await translatorMocks.getLLMCache(key) ?? `Generated ${key}`
        )

        const { target } = mountChats(messages, {
            loadPages: 1,
        })
        await waitForText(target, 'Third swipe')

        messages[0].swipes!.splice(2, 1)
        messages[0].swipeId = 1
        messages[0].data = 'Second swipe'
        storeMocks.ReloadChatPointer.set({ 0: 1 })

        await vi.waitFor(() => {
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
        setMessages(messages)
        translatorMocks.getLLMCache.mockImplementation(async (key: string) =>
            key === 'Second swipe' ? 'Translated second swipe' : null
        )
        translatorMocks.translateHTML.mockImplementation(async (key: string) =>
            await translatorMocks.getLLMCache(key) ?? `Generated ${key}`
        )

        const { target } = mountChats(messages, {
            loadPages: 1,
        })
        await waitForText(target, 'Second swipe')

        target.querySelector<HTMLButtonElement>('.button-icon-translate')?.click()
        await vi.waitFor(() => expect(target.textContent).toContain('Translated second swipe'))
        translatorMocks.translateHTML.mockClear()

        messages[0].swipeId = 2
        messages[0].data = 'Third swipe'
        storeMocks.ReloadChatPointer.set({ 0: 2 })

        await vi.waitFor(() => {
            expect(target.textContent).toContain('Third swipe')
        })
        expect(translatorMocks.translateHTML.mock.calls.some(
            ([source]) => source === 'Third swipe',
        )).toBe(false)
    })

    it('submits grouped fields and the submitter to Lua and commits the original chat after switching', async () => {
        const html = '<form risu-form="settings"><input name="choice" value="first"><input name="choice" value="second"><input name="__proto__" value="safe"><button name="intent" value="save">Save</button></form>'
        const character = DBState.db.characters[0]
        character.chaId = 'character-1'
        const origin = character.chats[0]
        origin.id = 'origin'
        origin.message[0].data = html
        const other = { ...origin, id: 'other', message: [{ role: 'user', data: 'Other', chatId: 'other-message' }] }
        character.chats.push(other as never)
        setChatPage(character, 0)
        let complete!: (result: { chat: typeof origin }) => void
        interactionMocks.runLuaInteractionTrigger.mockImplementationOnce(() => new Promise(resolve => { complete = resolve }))
        const { target } = mountChat({ message: html, totalLength: 1 })
        await vi.waitFor(() => expect(target.querySelector('form')).not.toBeNull())

        const form = target.querySelector('form')!
        const event = new SubmitEvent('submit', { bubbles: true, cancelable: true, submitter: form.querySelector('button') })
        form.dispatchEvent(event)
        expect(event.defaultPrevented).toBe(true)
        await vi.waitFor(() => expect(complete).toBeTypeOf('function'))
        const args = interactionMocks.runLuaInteractionTrigger.mock.calls[0]
        expect(args[2]).toBe('settings')
        expect(args[4].data).toEqual({ choice: ['first', 'second'], ['__proto__']: 'safe', intent: 'save' })
        setChatPage(character, 1)
        complete({ chat: { ...origin, scriptstate: { $submitted: 'yes' } } })
        await vi.waitFor(() => expect(character.chats[0].scriptstate?.$submitted).toBe('yes'))
        expect(character.chats[1].scriptstate).toBeUndefined()
    })

    it.each([
        ['post', undefined, true],
        ['dialog', undefined, false],
        ['post', 'dialog', false],
        ['dialog', 'post', true],
    ])('handles unbound form submission with method %s and override %s', async (method, override, prevented) => {
        const html = `<form method="${method}"><button ${override ? `formmethod="${override}"` : ''}>Submit</button></form>`
        const { target } = mountChat({ message: html, totalLength: 1 })
        await vi.waitFor(() => expect(target.querySelector('form')).not.toBeNull())
        const form = target.querySelector('form')!
        const event = new SubmitEvent('submit', { bubbles: true, cancelable: true, submitter: form.querySelector('button') })
        form.dispatchEvent(event)
        expect(event.defaultPrevented).toBe(prevented)
        expect(interactionMocks.runLuaInteractionTrigger).not.toHaveBeenCalled()
    })

    it.each([false, true])('updates internal Lua button output without retranslation or a redundant save (already saved: %s)', async chatSaved => {
        const buttonMessage = '<button risu-btn="change-view">Change</button>'
        DBState.db.translator = 'en'
        DBState.db.translatorType = 'llm'
        const character = DBState.db.characters[0]
        character.chaId = 'character-1'
        const chat = character.chats[0]
        chat.id = 'room-1'
        chat.message[0].data = buttonMessage
        parserMocks.ParseMarkdown.mockImplementation(async (value: string) =>
            chat.scriptstate?.$view === 'updated' ? '<p>Lua updated output</p>' : value
        )
        translatorMocks.translateHTML.mockImplementation(async (value: string) =>
            `${value}<p>Translated view</p>`
        )
        interactionMocks.runLuaInteractionTrigger.mockImplementation(async () => {
            // Reactive updates can arrive before the trigger finishes.
            storeMocks.ReloadGUIPointer.set(1)
            await Promise.resolve()
            chat.scriptstate = { $view: 'updated' }
            return { chat, chatSaved }
        })

        const { target } = mountChat({
            message: buttonMessage,
            renderCacheKey: 'room:lua-message',
        })
        await waitForText(target, 'Change')
        target.querySelector<HTMLButtonElement>('.button-icon-translate')!.click()
        await waitForText(target, 'Translated view')
        translatorMocks.translateHTML.mockClear()

        target.querySelector<HTMLButtonElement>('[risu-btn="change-view"]')!.click()
        await waitForText(target, 'Lua updated output')
        expect(target.textContent).not.toContain('Translated view')
        expect(chat.scriptstate?.$view).toBe('updated')
        expect(translatorMocks.translateHTML).not.toHaveBeenCalled()
        if (chatSaved) {
            expect(requestImmediateSave).not.toHaveBeenCalled()
        }
        else {
            await vi.waitFor(() => expect(requestImmediateSave).toHaveBeenCalled())
        }
    })

    it('opens blank historical and final editors independently', async () => {
        const messages: Message[] = [
            { role: 'user', data: '', chatId: 'message-0' },
            { role: 'char', data: '', chatId: 'message-1' },
        ]
        setMessages(messages)
        const { target } = mountChats(messages)
        await tick()

        const historical = target.querySelector<HTMLElement>('[data-chat-index="0"]')!
        const final = target.querySelector<HTMLElement>('[data-chat-index="1"]')!
        historical.querySelector<HTMLButtonElement>('.button-icon-edit')!.click()
        await tick()
        const editor = historical.querySelector<HTMLTextAreaElement>('.message-edit-area')!
        expect(editor.value).toBe('')
        editor.value = 'Historical draft'
        editor.dispatchEvent(new Event('input', { bubbles: true }))
        await tick()
        expect(final.querySelector('.message-edit-area')).toBeNull()

        final.querySelector<HTMLButtonElement>('.button-icon-edit')!.click()
        await tick()
        expect(final.querySelector<HTMLTextAreaElement>('.message-edit-area')?.value).toBe('')
        expect(historical.querySelector<HTMLTextAreaElement>('.message-edit-area')?.value).toBe('Historical draft')
    })

    it('only parses newly loaded history while preserving an open editor', async () => {
        const messages: Message[] = Array.from({ length: 60 }, (_, index) => ({
            role: index % 2 === 0 ? 'user' : 'char',
            data: `Message ${index}`,
            chatId: `message-${index}`,
        }))
        setMessages(messages)
        const { target, component } = mountChats(messages)
        await waitForText(target, 'Message 59')
        expect(target.querySelector('[data-chat-index]')?.getAttribute('data-chat-index')).toBe('30')
        expect(target.querySelector('[data-chat-index="0"]')).toBeNull()
        const editedMessage = target.querySelector<HTMLElement>('[data-chat-index="58"]')!
        editedMessage.querySelector<HTMLButtonElement>('.button-icon-edit')!.click()
        await tick()
        const editor = editedMessage.querySelector<HTMLTextAreaElement>('.message-edit-area')!
        editor.value = 'Unsaved history draft'
        editor.dispatchEvent(new Event('input', { bubbles: true }))
        await tick()
        parserMocks.ParseMarkdown.mockClear()

        component.$set({ loadPages: 60 })
        await waitForText(target, 'Message 0')
        const rendered = target.querySelectorAll<HTMLElement>('[data-chat-index]')
        expect(rendered[0].dataset.chatIndex).toBe('0')
        expect(rendered[rendered.length - 1].dataset.chatIndex).toBe('59')
        expect(target.querySelector<HTMLTextAreaElement>('[data-chat-index="58"] .message-edit-area')?.value)
            .toBe('Unsaved history draft')
        expect(parserMocks.ParseMarkdown.mock.calls.map(([source]) => source))
            .toEqual(messages.slice(0, 30).map(message => message.data))
    })

    it('keeps streaming content mounted and renders finalized output', async () => {
        DBState.db.useStreaming = true
        parserMocks.renderPreparedMarkdown.mockImplementation(async (source: string) =>
            source.trimStart().startsWith('<') ? source : `<p>${source.trim()}</p>`
        )
        parserMocks.ParseMarkdown.mockImplementation(async (source: string) =>
            `<section>Final parsed output: ${source}</section>`
        )
        const completedBlocks = 'Stable paragraph.\n\n'
            + '<div><img src="asset.png" alt="Streaming asset"></div>\n\n'
        const initialMessage: Message = {
            role: 'char',
            data: `${completedBlocks}Tail`,
            chatId: 'stream-1',
        }
        setMessages([initialMessage])
        const { target, component } = mountChats([initialMessage], {
            roomIsStreaming: true,
            roomIsResponding: true,
        })
        await waitForText(target, 'Tail')
        const paragraph = target.querySelector('p')
        const image = target.querySelector('img[alt="Streaming asset"]')
        expect(paragraph?.textContent).toBe('Stable paragraph.')
        expect(image).not.toBeNull()

        const growingMessage = { ...initialMessage, data: `${completedBlocks}Finished tail` }
        component.$set({ messages: [growingMessage] })
        await waitForText(target, 'Finished tail')
        expect(target.querySelector('p')).toBe(paragraph)
        expect(target.querySelector('img[alt="Streaming asset"]')).toBe(image)
        expect(target.textContent).not.toContain('Final parsed output:')

        component.$set({ roomIsStreaming: false, roomIsResponding: false })
        await waitForText(target, 'Final parsed output:')
        expect(target.textContent).toContain('Stable paragraph.')
        expect(target.textContent).toContain('Finished tail')
        expect(target.querySelector('img[alt="Streaming asset"]')).not.toBeNull()
    })
})
