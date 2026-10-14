// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from 'vitest'
import { acceptCompletion, completionStatus, startCompletion, type CompletionSource } from '@codemirror/autocomplete'
import { EditorView } from '@codemirror/view'
import { mount, tick, unmount } from 'svelte'
import CBSCodeEditor from './CBSCodeEditor.svelte'
import { createImageTagCompletionSource } from 'src/ts/imageGeneration/imageTags'

vi.mock('src/ts/storage/autoStorage', () => ({ forageStorage: { createAuth: vi.fn() } }))

const mounted: unknown[] = []

async function render(value: string, options: { completionSource?: CompletionSource } = {}) {
    const target = document.createElement('div')
    document.body.appendChild(target)
    const onValueChange = vi.fn()
    const component = mount(CBSCodeEditor, {
        target,
        props: {
            value,
            wordWrap: true,
            onValueChange,
            ...options,
        },
    })
    mounted.push(component)
    await tick()

    const content = target.querySelector<HTMLElement>('[role="textbox"]')!
    const editor = EditorView.findFromDOM(content)!
    return { target, content, editor, onValueChange }
}

function openCompletions(content: HTMLElement, editor: EditorView, position = editor.state.doc.length) {
    editor.dispatch({ selection: { anchor: position } })
    content.focus()
    startCompletion(editor)
}

function optionWithLabel(target: HTMLElement, label: string) {
    return [...target.querySelectorAll<HTMLElement>('[role="option"]')]
        .find(option => option.querySelector('.risu-completion-label')?.textContent === label)
}

afterEach(async () => {
    await Promise.all(mounted.splice(0).map(component => unmount(component as never)))
    document.body.replaceChildren()
})

describe('CBSCodeEditor', () => {
    it('completes a Korean image tag prefix while preserving following prompt text', async () => {
        const { target, content, editor, onValueChange } = await render('1girl, (장발 out:1.2), blue eyes', {
            completionSource: createImageTagCompletionSource({
                search: async () => [{ name: 'long hair', category: 0, count: 100, description: '긴 머리, 장발' }],
            }),
        })
        openCompletions(content, editor, 10)
        await vi.waitFor(() => expect(optionWithLabel(target, 'long hair')).toBeDefined())

        const option = optionWithLabel(target, 'long hair')!
        expect(option.querySelector('.risu-completion-detail')?.textContent).toContain('General')
        expect(option.querySelector('.risu-completion-description')?.textContent).toContain('긴 머리, 장발')
        await vi.waitFor(() => expect(acceptCompletion(editor)).toBe(true))
        expect(editor.state.doc.toString()).toBe('1girl, (long hair, out:1.2), blue eyes')
        expect(editor.state.selection.main.head).toBe(editor.state.doc.toString().indexOf('out'))
        expect(onValueChange).toHaveBeenLastCalledWith('1girl, (long hair, out:1.2), blue eyes')
    })

    it('reports document changes immediately to its owner', async () => {
        const { editor, onValueChange } = await render('before')
        editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: 'after' } })

        expect(onValueChange).toHaveBeenLastCalledWith('after')
    })

    it('renders the alias and short hint when accepting an ordinary CBS completion', async () => {
        const { target, content, editor } = await render('{{ch tail')
        openCompletions(content, editor, 4)
        await vi.waitFor(() => expect(optionWithLabel(target, 'char')).toBeDefined())

        const option = optionWithLabel(target, 'char')!
        expect(option.querySelector('.risu-completion-detail')?.textContent).toBe('bot')
        expect(option.querySelector('.risu-completion-description')?.textContent).toContain('selected character')
        expect(option.querySelector('.risu-completion-description')?.textContent).not.toContain('Usage::')
        await vi.waitFor(() => expect(acceptCompletion(editor)).toBe(true))
        expect(editor.state.doc.toString()).toBe('{{char}} tail')
    })

    it('keeps completions open on list interaction, closes on input clicks or Escape, and reopens after typing', async () => {
        const { target, content, editor } = await render('{{ch')
        openCompletions(content, editor)
        await vi.waitFor(() => expect(completionStatus(editor.state)).toBe('active'))

        const list = target.querySelector<HTMLElement>('[role="listbox"]')!
        list.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
        list.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }))
        expect(completionStatus(editor.state)).toBe('active')
        expect(document.activeElement).toBe(content)

        content.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
        expect(completionStatus(editor.state)).toBeNull()
        editor.dispatch({ selection: { anchor: 4 } })
        content.click()
        expect(completionStatus(editor.state)).toBeNull()

        editor.dispatch({ changes: { from: 4, insert: 'a' }, selection: { anchor: 5 }, userEvent: 'input.type' })
        expect(editor.state.doc.toString()).toBe('{{cha')
        await vi.waitFor(() => expect(completionStatus(editor.state)).toBe('active'))

        content.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
        expect(completionStatus(editor.state)).toBeNull()
        expect(document.activeElement).toBe(content)
        expect(editor.state.doc.toString()).toBe('{{cha')
    })

    it('renders a short hint and accepts a CBS block completion', async () => {
        const { target, content, editor } = await render('{{#wh')
        openCompletions(content, editor)
        await vi.waitFor(() => expect(optionWithLabel(target, '#when')).toBeDefined())

        const option = optionWithLabel(target, '#when')!
        expect(option.querySelector('.risu-completion-description')?.textContent)
            .toContain('logical, comparison, variable, and toggle operators')
        expect(option.querySelector('.risu-completion-description')?.textContent).not.toContain('Usage::')
        await vi.waitFor(() => expect(acceptCompletion(editor)).toBe(true))
        expect(editor.state.doc.toString()).toBe('{{#when ')
    })

    it('renders CBS highlighting and opens replace search with Ctrl+H', async () => {
        const { target, content } = await render('{{char}}')
        expect(target.querySelector('.cm-cbs-depth-1')?.textContent).toBe('{{char}}')

        content.focus()
        content.dispatchEvent(new KeyboardEvent('keydown', {
            key: 'h',
            code: 'KeyH',
            ctrlKey: true,
            bubbles: true,
            cancelable: true,
        }))
        await tick()

        expect(target.querySelector('input[name="search"]')).not.toBeNull()
        expect(target.querySelector('input[name="replace"]')).not.toBeNull()
        expect(target.querySelector('.risu-search-panel')).not.toBeNull()

        const replaceToggle = target.querySelector<HTMLButtonElement>('.risu-search-expand')!
        replaceToggle.click()
        expect(target.querySelector<HTMLDivElement>('.risu-search-replace-row')!.hidden).toBe(true)
        replaceToggle.click()

        const escapeEvent = new KeyboardEvent('keydown', {
            key: 'Escape',
            code: 'Escape',
            bubbles: true,
            cancelable: true,
        })
        content.dispatchEvent(escapeEvent)
        await tick()

        expect(escapeEvent.defaultPrevented).toBe(true)
        expect(target.querySelector('input[name="search"]')).toBeNull()
    })
})
