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
vi.mock('src/ts/process/scriptings', () => ({ runLuaButtonTrigger: vi.fn() }))
vi.mock('src/ts/process/scripts', () => ({ risuChatParser: (value: string) => value }))
vi.mock('src/ts/process/triggers', () => ({ runTrigger: vi.fn() }))
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
    alertConfirmMulti: vi.fn(),
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
    resolveInlayPlaceholders: vi.fn(),
    trimMarkdown: (value: string) => value,
}))
vi.mock('../../ts/translator/translator', () => ({
    getLLMCache: async () => null,
    getLLMTranslationCacheRevision: () => 0,
    setLLMCache: vi.fn(),
    subscribeLLMTranslationCache: () => () => {},
    translateHTML: async (value: string) => value,
}))
vi.mock('../../ts/storage/database.svelte', () => ({
    getCurrentCharacter: () => storeMocks.DBState.db.characters[0],
    getCurrentChat: () => storeMocks.DBState.db.characters[0].chats[0],
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
            const display = !options.streaming
                && Boolean(options.data.trim())
                && (options.translated || Boolean(storeMocks.DBState.db.autoTranslate))
            if (display) snapshot.cacheKey = await options.parseMarkdown(options.data, 'pretranslate')
            return display
        },
        waitForResult: async () => {},
        acknowledgeResolved: async () => {},
    }),
}))

import { mount, tick, unmount } from 'svelte'
import Chat from './Chat.svelte'
import Chats from './Chats.svelte'
import { clearChatBodyRenderCache } from './chatBodyRenderCache'
import { DBState } from 'src/ts/stores.svelte'
import type { character, Message } from 'src/ts/storage/database.svelte'

const mountedComponents: unknown[] = []

beforeEach(() => {
    clearChatBodyRenderCache()
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

describe('Chat editing', () => {
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
})
