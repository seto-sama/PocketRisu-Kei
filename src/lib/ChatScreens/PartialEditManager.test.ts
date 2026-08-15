// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const storeMocks = vi.hoisted(() => {
    let reloadValue: Record<number, number> = {}
    return {
        DBState: { db: {} as any },
        selIdState: { selId: 0 },
        ReloadChatPointer: {
            subscribe(run: (value: Record<number, number>) => void) {
                run(reloadValue)
                return () => {}
            },
            set(value: Record<number, number>) {
                reloadValue = value
            },
            update(updater: (value: Record<number, number>) => Record<number, number>) {
                reloadValue = updater(reloadValue)
            },
        },
    }
})

vi.mock('src/ts/stores.svelte', () => storeMocks)
vi.mock('src/ts/alert', () => ({ alertConfirm: vi.fn() }))
vi.mock('src/ts/gui/guisize', async () => {
    const { writable } = await import('svelte/store')
    return {
        textAreaSize: writable(0),
        textAreaTextSize: writable(0),
    }
})

import { mount, tick, unmount } from 'svelte'
import { get } from 'svelte/store'
import PartialEditManager from './PartialEditManager.svelte'
import { DBState, ReloadChatPointer } from 'src/ts/stores.svelte'
import type { Message } from 'src/ts/storage/database.svelte'

const mountedComponents: unknown[] = []

function createChatScreen(messages: Message[]) {
    const screenRoot = document.createElement('div')
    screenRoot.className = 'default-chat-screen'

    messages.forEach((message, index) => {
        const chatRoot = document.createElement('div')
        chatRoot.className = 'risu-chat'
        chatRoot.dataset.chatIndex = String(index)
        chatRoot.dataset.chatId = message.chatId ?? ''

        const bodyRoot = document.createElement('span')
        bodyRoot.className = 'chattext'
        const paragraph = document.createElement('p')
        paragraph.textContent = message.data
        paragraph.getBoundingClientRect = () => new DOMRect(20, 100, 240, 40)
        bodyRoot.appendChild(paragraph)
        chatRoot.appendChild(bodyRoot)
        screenRoot.appendChild(chatRoot)
    })

    document.body.appendChild(screenRoot)
    return screenRoot
}

function renderManager(screenRoot: HTMLElement, messages: Message[], options: {
    blockEditEnabled?: boolean
    dragEditEnabled?: boolean
} = {}) {
    const target = document.createElement('div')
    document.body.appendChild(target)
    const mounted = mount(PartialEditManager, {
        target,
        props: {
            screenRoot,
            messages,
            characterIndex: 0,
            chatPage: 0,
            chatId: 'chat-1',
            blockEditEnabled: options.blockEditEnabled ?? true,
            dragEditEnabled: options.dragEditEnabled ?? true,
        },
    })
    mountedComponents.push(mounted)
    return { target, mounted }
}

beforeEach(() => {
    DBState.db = {
        zoomsize: 100,
        lineHeight: 1.25,
        characters: [{
            chatPage: 0,
            chats: [{
                id: 'chat-1',
                message: [],
            }],
        }],
    } as typeof DBState.db
    ReloadChatPointer.set({})
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
        queueMicrotask(() => callback(0))
        return 1
    })
    vi.stubGlobal('cancelAnimationFrame', vi.fn())
})

afterEach(async () => {
    const components = mountedComponents.splice(0)
    await Promise.all(components.map(component => unmount(component as never)))
    document.body.replaceChildren()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
})

describe('PartialEditManager', () => {
    it('registers one shared document listener set regardless of message count', async () => {
        const messages: Message[] = Array.from({ length: 20 }, (_, index) => ({
            role: 'char',
            data: `message ${index}`,
            chatId: `message-${index}`,
        }))
        DBState.db.characters[0].chats[0].message = messages
        const screenRoot = createChatScreen(messages)
        const addSpy = vi.spyOn(document, 'addEventListener')
        const removeSpy = vi.spyOn(document, 'removeEventListener')

        const { mounted } = renderManager(screenRoot, messages)
        await tick()

        for (const eventName of ['mousemove', 'selectionchange', 'mousedown', 'scroll']) {
            expect(addSpy.mock.calls.filter(([name]) => name === eventName)).toHaveLength(1)
        }

        await unmount(mounted as never)
        mountedComponents.splice(mountedComponents.indexOf(mounted), 1)

        for (const eventName of ['mousemove', 'selectionchange', 'mousedown', 'scroll']) {
            expect(removeSpy.mock.calls.some(([name]) => name === eventName)).toBe(true)
        }
    })

    it('edits the resolved message and increments only its reload pointer', async () => {
        const messages: Message[] = [
            { role: 'char', data: 'first message', chatId: 'message-0' },
            { role: 'char', data: 'second message', chatId: 'message-1', swipes: ['second message'], swipeId: 0 },
        ]
        DBState.db.characters[0].chats[0].message = messages
        const screenRoot = createChatScreen(messages)
        const paragraph = screenRoot.querySelectorAll('p')[1] as HTMLParagraphElement
        vi.spyOn(document, 'elementFromPoint').mockReturnValue(paragraph)

        const { target } = renderManager(screenRoot, messages, { dragEditEnabled: false })
        await tick()

        document.dispatchEvent(new MouseEvent('mousemove', { clientX: 30, clientY: 110 }))
        await tick()

        const editButton = document.body.querySelector<HTMLButtonElement>('.partial-edit-btn-edit')
        expect(editButton).not.toBeNull()
        editButton?.click()
        await tick()

        const textarea = document.body.querySelector<HTMLTextAreaElement>('textarea')
        expect(textarea).not.toBeNull()
        textarea!.value = 'updated message'
        textarea!.dispatchEvent(new Event('input', { bubbles: true }))
        await tick()

        document.body.querySelector<HTMLButtonElement>('.partial-edit-save-btn')?.click()
        await tick()

        expect(DBState.db.characters[0].chats[0].message[0].data).toBe('first message')
        expect(DBState.db.characters[0].chats[0].message[1].data).toBe('updated message')
        expect(DBState.db.characters[0].chats[0].message[1].swipes?.[0]).toBe('updated message')
        expect(get(ReloadChatPointer)).toEqual({ 1: 1 })
        expect(target.querySelector('.partial-edit-overlay')).toBeNull()
    })

    it('does not treat the chat body root as an editable content block', async () => {
        const messages: Message[] = [
            { role: 'char', data: 'message body', chatId: 'message-0' },
        ]
        DBState.db.characters[0].chats[0].message = messages
        const screenRoot = createChatScreen(messages)
        const bodyRoot = screenRoot.querySelector<HTMLElement>('.chattext')!
        vi.spyOn(document, 'elementFromPoint').mockReturnValue(bodyRoot)

        renderManager(screenRoot, messages, { dragEditEnabled: false })
        await tick()
        document.dispatchEvent(new MouseEvent('mousemove', { clientX: 30, clientY: 110 }))
        await tick()

        expect(document.body.querySelector('.partial-edit-btn-wrapper')).toBeNull()
    })

    it('positions block controls immediately after the last rendered character', async () => {
        const messages: Message[] = [
            { role: 'char', data: 'message body', chatId: 'message-0' },
        ]
        DBState.db.characters[0].chats[0].message = messages
        const screenRoot = createChatScreen(messages)
        const paragraph = screenRoot.querySelector('p')!
        vi.spyOn(document, 'elementFromPoint').mockReturnValue(paragraph)
        vi.spyOn(document, 'createRange').mockReturnValue({
            selectNodeContents: vi.fn(),
            getClientRects: () => [new DOMRect(100, 120, 8, 16)],
        } as unknown as Range)

        renderManager(screenRoot, messages, { dragEditEnabled: false })
        await tick()
        document.dispatchEvent(new MouseEvent('mousemove', { clientX: 30, clientY: 110 }))
        await tick()

        const controls = document.body.querySelector<HTMLElement>('.partial-edit-btn-wrapper')
        expect(controls?.style.left).toBe('108px')
        expect(controls?.style.top).toBe('116px')
        expect(controls?.style.paddingLeft).toBe('4px')
        expect(controls?.style.paddingTop).toBe('0px')
    })

    it('positions drag-selection controls after the final selected line', async () => {
        const messages: Message[] = [
            { role: 'char', data: 'message body', chatId: 'message-0' },
        ]
        DBState.db.characters[0].chats[0].message = messages
        const screenRoot = createChatScreen(messages)
        const paragraph = screenRoot.querySelector('p')!
        const textNode = paragraph.firstChild!
        const range = {
            commonAncestorContainer: textNode,
            startContainer: textNode,
            endContainer: textNode,
            getBoundingClientRect: () => new DOMRect(20, 100, 160, 36),
            getClientRects: () => [
                new DOMRect(20, 100, 160, 16),
                new DOMRect(20, 120, 60, 16),
            ],
        } as unknown as Range
        vi.spyOn(window, 'getSelection').mockReturnValue({
            isCollapsed: false,
            rangeCount: 1,
            toString: () => 'message body',
            getRangeAt: () => range,
        } as unknown as Selection)

        renderManager(screenRoot, messages, { blockEditEnabled: false })
        await tick()
        document.dispatchEvent(new Event('selectionchange'))
        await vi.waitFor(() => {
            expect(document.body.querySelector('.partial-edit-drag-btn-wrapper')).not.toBeNull()
        })

        const controls = document.body.querySelector<HTMLElement>('.partial-edit-drag-btn-wrapper')
        expect(controls?.style.left).toBe('80px')
        expect(controls?.style.top).toBe('136px')
        expect(controls?.style.paddingTop).toBe('4px')
    })

    it('edits the active translation cache without mutating the original message', async () => {
        const messages: Message[] = [
            { role: 'char', data: 'original message', chatId: 'message-0' },
        ]
        DBState.db.characters[0].chats[0].message = messages
        const screenRoot = createChatScreen(messages)
        const chatRoot = screenRoot.querySelector<HTMLElement>('[data-chat-index="0"]')!
        const paragraph = chatRoot.querySelector('p')!
        paragraph.textContent = 'translated message'
        chatRoot.dataset.partialEditTranslated = 'true'
        vi.spyOn(document, 'elementFromPoint').mockReturnValue(paragraph)

        chatRoot.addEventListener('risu-partial-edit-translation-context', (event) => {
            const detail = (event as CustomEvent<{
                respond: (context: Promise<{ key: string; data: string } | null>) => void
            }>).detail
            detail.respond(Promise.resolve({ key: 'cache-key', data: 'translated message' }))
        })
        const saveSpy = vi.fn()
        chatRoot.addEventListener('risu-partial-edit-translation-save', saveSpy)

        renderManager(screenRoot, messages, { dragEditEnabled: false })
        await tick()
        document.dispatchEvent(new MouseEvent('mousemove', { clientX: 30, clientY: 110 }))
        await tick()
        document.body.querySelector<HTMLButtonElement>('.partial-edit-btn-edit')?.click()
        await vi.waitFor(() => {
            expect(document.body.querySelector('textarea')).not.toBeNull()
        })

        const textarea = document.body.querySelector<HTMLTextAreaElement>('textarea')!
        expect(textarea.value).toBe('translated message')
        textarea.value = 'updated translation'
        textarea.dispatchEvent(new Event('input', { bubbles: true }))
        await tick()
        document.body.querySelector<HTMLButtonElement>('.partial-edit-save-btn')?.click()
        await tick()

        expect(messages[0].data).toBe('original message')
        expect(get(ReloadChatPointer)).toEqual({})
        expect(saveSpy).toHaveBeenCalledOnce()
        expect((saveSpy.mock.calls[0][0] as CustomEvent).detail).toEqual({
            key: 'cache-key',
            data: 'updated translation',
        })
    })

    it('ignores the first greeting and cancels a stale edit target', async () => {
        const messages: Message[] = [
            { role: 'char', data: 'editable message', chatId: 'message-0' },
        ]
        DBState.db.characters[0].chats[0].message = messages
        const screenRoot = createChatScreen(messages)

        const greeting = document.createElement('div')
        greeting.className = 'risu-chat'
        greeting.dataset.chatIndex = '-1'
        const greetingBody = document.createElement('span')
        greetingBody.className = 'chattext'
        const greetingParagraph = document.createElement('p')
        greetingParagraph.textContent = 'greeting'
        greetingBody.appendChild(greetingParagraph)
        greeting.appendChild(greetingBody)
        screenRoot.appendChild(greeting)

        const elementFromPoint = vi.spyOn(document, 'elementFromPoint')
        const { target } = renderManager(screenRoot, messages, { dragEditEnabled: false })
        await tick()

        elementFromPoint.mockReturnValue(greetingParagraph)
        document.dispatchEvent(new MouseEvent('mousemove', { clientX: 10, clientY: 10 }))
        await tick()
        expect(document.body.querySelector('.partial-edit-btn-wrapper')).toBeNull()

        const paragraph = screenRoot.querySelector<HTMLParagraphElement>('[data-chat-index="0"] p')!
        paragraph.getBoundingClientRect = () => new DOMRect(20, 100, 240, 40)
        elementFromPoint.mockReturnValue(paragraph)
        document.dispatchEvent(new MouseEvent('mousemove', { clientX: 30, clientY: 110 }))
        await tick()
        document.body.querySelector<HTMLButtonElement>('.partial-edit-btn-edit')?.click()
        await tick()
        expect(document.body.querySelector('textarea')).not.toBeNull()

        DBState.db.characters[0].chats[0].message[0].data = 'changed elsewhere'
        document.body.querySelector<HTMLButtonElement>('.partial-edit-save-btn')?.click()
        await tick()

        expect(DBState.db.characters[0].chats[0].message[0].data).toBe('changed elsewhere')
        expect(get(ReloadChatPointer)).toEqual({})
        expect(document.body.querySelector('textarea')).toBeNull()
    })
})
