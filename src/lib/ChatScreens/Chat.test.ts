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

    return {
        DBState: { db: {} as any },
        createSimpleCharacter: (character: unknown) => character,
        ReloadChatPointer: writable<Record<number, number>>({}),
        ReloadGUIPointer: writable(0),
        selectedCharID: writable(0),
        HideIconStore: writable(false),
        CurrentTriggerIdStore: writable<string | null>(null),
        selIdState: { selId: 0 },
        popupStore: { openId: 0, children: null, mouseX: 0, mouseY: 0 },
    }
})

const parserMocks = vi.hoisted(() => ({
    ParseMarkdown: vi.fn(async (value: string) => value),
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
    getLLMCache: vi.fn(async (_key: string) => null as string | null),
    setLLMCache: vi.fn(async () => {}),
    translateHTML: vi.fn(async (value: string) => value),
}))

vi.mock('src/ts/stores.svelte', () => storeMocks)
vi.mock('src/ts/globalApi.svelte', () => ({
    aiLawApplies: () => false,
    changeChatTo: vi.fn(),
    chatFoldedStateMessageIndex: { index: -1 },
    createChatCopyName: (name: string) => name,
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
    postTranslationParse: (value: string) => value,
    prepareMarkdownSource: parserMocks.prepareMarkdownSource,
    renderPreparedMarkdown: parserMocks.renderPreparedMarkdown,
    resolveInlayPlaceholders: vi.fn(),
    trimMarkdown: (value: string) => value,
}))
vi.mock('../../ts/translator/translator', () => ({
    getLLMCache: translatorMocks.getLLMCache,
    getLLMTranslationCacheRevision: () => 0,
    setLLMCache: translatorMocks.setLLMCache,
    subscribeLLMTranslationCache: () => () => {},
    translateHTML: translatorMocks.translateHTML,
}))
vi.mock('../../ts/storage/database.svelte', () => ({
    getCurrentCharacter: () => storeMocks.DBState.db.characters[0],
    getCurrentChat: () => storeMocks.DBState.db.characters[0].chats[0],
    normalizeChat: (chat: unknown) => chat,
    setCurrentChat: vi.fn(),
}))
vi.mock('src/ts/process/modules', () => ({ getModuleAssets: () => [] }))
vi.mock('src/ts/characters', () => ({ getCharImage: (value: string) => value }))
vi.mock('src/ts/gui/longtouch', () => ({ longpress: () => ({ destroy() {} }) }))
vi.mock('src/ts/process/revenant/recovery', () => ({
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
                parseMarkdown: (data: string, mode: 'pretranslate') => Promise<string>
            },
        ) => {
            if (options.streaming || !options.data.trim()) return false
            const display = options.translated || Boolean(storeMocks.DBState.db.autoTranslate)
            if (!display) return false
            const cacheKey = await options.parseMarkdown(options.data, 'pretranslate')
            snapshot.cacheKey = cacheKey
            if (
                storeMocks.DBState.db.autoTranslateCachedOnly
                && storeMocks.DBState.db.translatorType === 'llm'
                && !options.translated
            ) return await translatorMocks.getLLMCache(cacheKey) !== null
            return true
        },
        waitForResult: async () => {},
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
    parserMocks.ParseMarkdown.mockImplementation(async (value: string) => value)
    parserMocks.prepareMarkdownSource.mockImplementation(async (value: string) => value)
    parserMocks.renderPreparedMarkdown.mockImplementation(
        async (value: string) => `<p>${value.trim()}</p>`,
    )
    translatorMocks.getLLMCache.mockResolvedValue(null)
    translatorMocks.translateHTML.mockImplementation(async (value: string) => value)
    DBState.db = {
        theme: 'standardRisu',
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
        DBState.db.legacyTranslation = false

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
                isLastMemory: false,
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
                isLastMemory: false,
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
        DBState.db.legacyTranslation = false
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
                isLastMemory: false,
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
                isLastMemory: false,
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

        editor!.value = 'Edited user message'
        editor!.dispatchEvent(new Event('input', { bubbles: true }))
        await tick()
        target.querySelector<HTMLButtonElement>('.button-icon-edit')?.click()
        await tick()

        expect(DBState.db.characters[0].chats[0].message[0].data).toBe('Edited user message')
        expect(target.querySelector('.message-edit-area')).toBeNull()
    })

    it('uses the shared pencil button to edit the visible LLM translation', async () => {
        DBState.db.translator = 'en'
        DBState.db.translatorType = 'llm'
        DBState.db.legacyTranslation = false
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
                isLastMemory: false,
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

    it('keeps a translation edit scoped to its original swipe', async () => {
        DBState.db.translator = 'en'
        DBState.db.translatorType = 'llm'
        DBState.db.legacyTranslation = false
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
                isLastMemory: false,
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

    it('restores a cached translation after deleting the selected swipe', async () => {
        DBState.db.translator = 'en'
        DBState.db.translatorType = 'llm'
        DBState.db.legacyTranslation = false
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

    it('does not automatically retranslate content changed by an internal Lua button', async () => {
        const buttonMessage = '<button risu-btn="change-view">Change</button>'
        DBState.db.translator = 'en'
        DBState.db.translatorType = 'llm'
        DBState.db.legacyTranslation = false
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
                isLastMemory: false,
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

    it('reserves one toolbar row when generation and translation controls are absent', async () => {
        const target = document.createElement('div')
        document.body.appendChild(target)
        const component = mount(Chat, {
            target,
            props: {
                message: 'First message',
                name: 'Character',
                role: 'char',
                idx: -1,
                firstMessage: true,
                totalLength: 1,
                isLastMemory: false,
            },
        })
        mountedComponents.push(component)
        await tick()

        const generationInfo = target.querySelector('.chat-generation-info')
        expect(generationInfo?.getAttribute('data-icon-size')).toBe('lg')
        expect((generationInfo as HTMLElement | null)?.style.minHeight).toBe('var(--icon-cell-size)')
    })

    it('hides the model label on mobile while retaining its icon', async () => {
        DBState.db.requestInfoInsideChat = true
        const target = document.createElement('div')
        document.body.appendChild(target)
        const component = mount(Chat, {
            target,
            props: {
                message: 'Model response',
                name: 'Character',
                role: 'char',
                idx: -1,
                messageGenerationInfo: { model: 'test-model' },
                totalLength: 1,
                isLastMemory: false,
            },
        })
        mountedComponents.push(component)
        await tick()

        const modelButton = target.querySelector<HTMLButtonElement>('.chat-generation-info button')
        const modelLabel = modelButton?.querySelector('span')
        expect(modelButton?.querySelector('svg')).not.toBeNull()
        expect(modelLabel?.classList.contains('hidden')).toBe(true)
        expect(modelLabel?.classList.contains('sm:inline')).toBe(true)
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
        const editedMessage = target.querySelector<HTMLElement>('[data-chat-index="58"]')
        editedMessage?.querySelector<HTMLButtonElement>('.button-icon-edit')?.click()
        await tick()
        expect(editedMessage?.querySelector('.message-edit-area')).not.toBeNull()

        props.loadPages += 30
        storeMocks.ReloadChatPointer.set({})
        await tick()
        await waitForParserCalls(60)

        expect(target.querySelectorAll('.chat-message-container')).toHaveLength(60)
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
        scrollHost.scrollTop = -500

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
