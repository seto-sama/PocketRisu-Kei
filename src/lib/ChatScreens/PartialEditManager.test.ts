// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const storeMocks = vi.hoisted(() => ({
    DBState: { db: {} as any },
    selIdState: { selId: 0 },
    invalidateChatMessageRender: vi.fn(),
}))

vi.mock('src/ts/stores.svelte', () => storeMocks)
vi.mock('src/ts/gui/guisize', async () => {
    const { writable } = await import('svelte/store')
    return {
        textAreaSize: writable(0),
        textAreaTextSize: writable(0),
    }
})

import { mount, tick, unmount } from 'svelte'
import PartialEditManager from './PartialEditManager.svelte'
import { DBState, invalidateChatMessageRender } from 'src/ts/stores.svelte'
import type { Message } from 'src/ts/storage/database.svelte'
import { language } from 'src/lang'

const mountedComponents: unknown[] = []

function createChatScreen(messages: Message[]) {
    const screenRoot = document.createElement('div')
    screenRoot.className = 'default-chat-screen'

    messages.forEach((message, index) => {
        const chatRoot = document.createElement('div')
        chatRoot.className = 'risu-chat'
        chatRoot.dataset.chatIndex = String(index)

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
}

function mockTextSelection(textNode: Node, selectedText: string) {
    const range = {
        commonAncestorContainer: textNode,
        startContainer: textNode,
        endContainer: textNode,
        getBoundingClientRect: () => new DOMRect(20, 100, 100, 16),
        getClientRects: () => [new DOMRect(20, 100, 100, 16)],
    } as unknown as Range
    vi.spyOn(window, 'getSelection').mockReturnValue({
        isCollapsed: false,
        rangeCount: 1,
        toString: () => selectedText,
        getRangeAt: () => range,
    } as unknown as Selection)
}

beforeEach(() => {
    DBState.db = {
        zoomsize: 100,
        lineHeight: 1.25,
        characters: [{
            chats: [{
                id: 'chat-1',
                message: [],
            }],
        }],
    } as typeof DBState.db
    vi.mocked(invalidateChatMessageRender).mockClear()
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
    it('edits the resolved message and increments only its reload pointer', async () => {
        const messages: Message[] = [
            { role: 'char', data: 'first message', chatId: 'message-0' },
            { role: 'char', data: 'second message', chatId: 'message-1', swipes: ['second message'], swipeId: 0 },
        ]
        DBState.db.characters[0].chats[0].message = messages
        const screenRoot = createChatScreen(messages)
        const paragraph = screenRoot.querySelectorAll('p')[1] as HTMLParagraphElement
        vi.spyOn(document, 'elementFromPoint').mockReturnValue(paragraph)

        renderManager(screenRoot, messages, { dragEditEnabled: false })
        await tick()

        document.dispatchEvent(new MouseEvent('mousemove', { clientX: 30, clientY: 110 }))
        await tick()

        const editButton = document.body.querySelector<HTMLButtonElement>('.partial-edit-btn-edit')
        expect(editButton).not.toBeNull()
        const controls = editButton!.parentElement!
        screenRoot.dispatchEvent(new MouseEvent('mouseleave', { relatedTarget: controls }))
        controls.dispatchEvent(new MouseEvent('mouseleave', { relatedTarget: paragraph }))
        expect(controls.style.display).not.toBe('none')
        editButton!.click()
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
        expect(invalidateChatMessageRender).toHaveBeenCalledExactlyOnceWith(1)
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

    it('edits the selected occurrence when a drag selection has multiple matches', async () => {
        const messages: Message[] = [
            { role: 'char', data: 'repeat phrase\nmiddle\nrepeat phrase', chatId: 'message-0' },
        ]
        DBState.db.characters[0].chats[0].message = messages
        const screenRoot = createChatScreen(messages)
        const textNode = screenRoot.querySelector('p')!.firstChild!
        mockTextSelection(textNode, 'repeat phrase')

        renderManager(screenRoot, messages, { blockEditEnabled: false })
        await tick()
        document.dispatchEvent(new Event('selectionchange'))
        await vi.waitFor(() => {
            expect(document.body.querySelector('.partial-edit-drag-btn-wrapper')).not.toBeNull()
        })

        document.body.querySelector<HTMLButtonElement>('.partial-edit-btn-edit')?.click()
        await vi.waitFor(() => {
            expect(document.body.querySelector('[role="dialog"]')).not.toBeNull()
        })

        const dialog = document.body.querySelector<HTMLElement>('[role="dialog"]')!
        const matchButtons = Array.from(dialog.querySelectorAll<HTMLButtonElement>('button'))
            .filter(button => button.textContent?.includes('repeat phrase'))
        expect(matchButtons).toHaveLength(2)
        expect(document.body.querySelector('textarea')).toBeNull()

        matchButtons[1].click()
        await vi.waitFor(() => {
            expect(document.body.querySelector('textarea')).not.toBeNull()
        })

        const textarea = document.body.querySelector<HTMLTextAreaElement>('textarea')!
        textarea.value = 'updated phrase'
        textarea.dispatchEvent(new Event('input', { bubbles: true }))
        await tick()
        document.body.querySelector<HTMLButtonElement>('.partial-edit-save-btn')?.click()
        await tick()

        expect(messages[0].data).toBe('repeat phrase\nmiddle\nupdated phrase')
    })

    it('ignores a cancelled translation match and edits only the newly selected translation', async () => {
        const messages: Message[] = [
            { role: 'char', data: 'original first', chatId: 'message-0' },
            { role: 'char', data: 'original second', chatId: 'message-1' },
        ]
        DBState.db.characters[0].chats[0].message = messages
        const screenRoot = createChatScreen(messages)
        const roots = screenRoot.querySelectorAll<HTMLElement>('.risu-chat')
        const paragraphs = screenRoot.querySelectorAll('p')
        const requests = messages.map(() => {
            let resolve!: (context: { key: string; data: string }) => void
            const promise = new Promise<{ key: string; data: string }>(finish => { resolve = finish })
            return { promise, resolve }
        })
        const saves = messages.map(() => vi.fn())
        roots.forEach((root, index) => {
            root.dataset.partialEditTranslated = 'true'
            paragraphs[index].textContent = `translated ${index}`
            root.addEventListener('risu-partial-edit-translation-context', event => {
                (event as CustomEvent).detail.respond(requests[index].promise)
            })
            root.addEventListener('risu-partial-edit-translation-save', saves[index])
        })
        const hit = vi.spyOn(document, 'elementFromPoint').mockReturnValue(paragraphs[0])

        renderManager(screenRoot, messages, { dragEditEnabled: false })
        await tick()
        document.dispatchEvent(new MouseEvent('mousemove', { clientX: 30, clientY: 110 }))
        await tick()
        document.body.querySelector<HTMLButtonElement>('.partial-edit-btn-edit')?.click()
        await tick()
        expect(document.querySelector('[role="dialog"]')).toBeNull()
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
        hit.mockReturnValue(paragraphs[1])
        document.dispatchEvent(new MouseEvent('mousemove', { clientX: 30, clientY: 110 }))
        await tick()
        document.body.querySelector<HTMLButtonElement>('.partial-edit-btn-edit')!.click()
        requests[0].resolve({ key: 'first-cache', data: 'translated 0' })
        await tick()
        await tick()
        expect(document.querySelector('textarea')).toBeNull()
        requests[1].resolve({ key: 'second-cache', data: 'translated 1' })
        await vi.waitFor(() => {
            expect(document.body.querySelector('textarea')).not.toBeNull()
        })

        const textarea = document.body.querySelector<HTMLTextAreaElement>('textarea')!
        expect(textarea.value).toBe('translated 1')
        textarea.value = 'updated translation'
        textarea.dispatchEvent(new Event('input', { bubbles: true }))
        await tick()
        document.body.querySelector<HTMLButtonElement>('.partial-edit-save-btn')?.click()
        await tick()

        expect(messages.map(message => message.data)).toEqual(['original first', 'original second'])
        expect(invalidateChatMessageRender).not.toHaveBeenCalled()
        expect(saves[0]).not.toHaveBeenCalled()
        expect(saves[1]).toHaveBeenCalledOnce()
        expect((saves[1].mock.calls[0][0] as CustomEvent).detail).toEqual({
            key: 'second-cache',
            data: 'updated translation',
        })
    })

    it('allows editing again after a translation lookup fails', async () => {
        const messages: Message[] = [{ role: 'char', data: 'message', chatId: 'message-0' }]
        DBState.db.characters[0].chats[0].message = messages
        const screenRoot = createChatScreen(messages)
        const root = screenRoot.querySelector<HTMLElement>('.risu-chat')!
        const paragraph = root.querySelector('p')!
        root.dataset.partialEditTranslated = 'true'
        const context = vi.fn()
            .mockRejectedValueOnce(new Error('Cache read failed'))
            .mockResolvedValue({ key: 'cache-key', data: 'message' })
        root.addEventListener('risu-partial-edit-translation-context', event => {
            (event as CustomEvent).detail.respond(context())
        })
        vi.spyOn(document, 'elementFromPoint').mockReturnValue(paragraph)
        renderManager(screenRoot, messages, { dragEditEnabled: false })
        await tick()
        document.dispatchEvent(new MouseEvent('mousemove', { clientX: 30, clientY: 110 }))
        await tick()
        document.querySelector<HTMLButtonElement>('.partial-edit-btn-edit')!.click()
        await vi.waitFor(() => expect(document.querySelector('[role="dialog"]')?.textContent).toContain(language.partialEdit.matchFailedTitle))
        const confirm = Array.from(document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button'))
            .find(button => button.textContent?.trim() === language.confirm)!
        confirm.click()
        await tick()
        document.dispatchEvent(new MouseEvent('mousemove', { clientX: 30, clientY: 110 }))
        await tick()
        document.querySelector<HTMLButtonElement>('.partial-edit-btn-edit')!.click()
        await vi.waitFor(() => expect(document.querySelector('textarea')).not.toBeNull())
        expect(document.querySelector<HTMLTextAreaElement>('textarea')!.value).toBe('message')
        expect(context).toHaveBeenCalledTimes(2)
        expect(messages[0].data).toBe('message')
    })

    it('deletes only the selected block after confirmation', async () => {
        const messages: Message[] = [{ role: 'char', data: 'keep this\n\ndelete this', chatId: 'message-0' }]
        DBState.db.characters[0].chats[0].message = messages
        const screenRoot = createChatScreen(messages)
        const paragraph = screenRoot.querySelector('p')!
        paragraph.textContent = 'delete this'
        vi.spyOn(document, 'elementFromPoint').mockReturnValue(paragraph)
        renderManager(screenRoot, messages, { dragEditEnabled: false })
        await tick()
        document.dispatchEvent(new MouseEvent('mousemove', { clientX: 30, clientY: 110 }))
        await tick()
        document.querySelector<HTMLButtonElement>('.partial-edit-btn-delete')!.click()
        await tick()

        expect(messages[0].data).toBe('keep this\n\ndelete this')
        const confirm = Array.from(document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button'))
            .find(button => button.textContent?.trim() === language.partialEdit.deleteYes)!
        confirm.click()
        await tick()

        expect(messages[0].data).toBe('keep this')
        expect(invalidateChatMessageRender).toHaveBeenCalledExactlyOnceWith(0)
    })

    it('does not offer partial editing for the first greeting', async () => {
        const messages: Message[] = [
            { role: 'char', data: 'editable message', chatId: 'message-0' },
        ]
        DBState.db.characters[0].chats[0].message = messages
        const screenRoot = createChatScreen(messages)

        screenRoot.querySelector<HTMLElement>('.risu-chat')!.dataset.chatIndex = '-1'
        vi.spyOn(document, 'elementFromPoint').mockReturnValue(screenRoot.querySelector('p'))
        renderManager(screenRoot, messages, { dragEditEnabled: false })
        await tick()

        document.dispatchEvent(new MouseEvent('mousemove', { clientX: 10, clientY: 10 }))
        await tick()
        expect(document.body.querySelector('.partial-edit-btn-wrapper')).toBeNull()
    })

    it('does not overwrite a message changed while editing', async () => {
        const messages: Message[] = [{ role: 'char', data: 'editable message', chatId: 'message-0' }]
        DBState.db.characters[0].chats[0].message = messages
        const screenRoot = createChatScreen(messages)
        const paragraph = screenRoot.querySelector('p')!
        const elementFromPoint = vi.spyOn(document, 'elementFromPoint')
        renderManager(screenRoot, messages, { dragEditEnabled: false })
        await tick()
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
        expect(invalidateChatMessageRender).not.toHaveBeenCalled()
        expect(document.body.querySelector('textarea')).toBeNull()
    })
})
