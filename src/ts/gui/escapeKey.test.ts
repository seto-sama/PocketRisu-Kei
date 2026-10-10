import { afterEach, describe, expect, it, vi } from 'vitest'
import { isTextEntryElement, requestDialogCloseAction, requestEscapeAction } from './escapeKey'

afterEach(() => document.body.replaceChildren())

function focusedInput() {
    const input = document.createElement('input')
    document.body.appendChild(input)
    input.focus()
    return input
}

describe('Escape requests', () => {
    it('uses the focused control even when it stops event propagation', () => {
        const input = focusedInput()
        const cancelEdit = vi.fn((event: KeyboardEvent) => {
            event.stopPropagation()
            event.preventDefault()
        })
        input.addEventListener('keydown', cancelEdit)

        expect(requestEscapeAction()).toBe(true)
        expect(cancelEdit).toHaveBeenCalledOnce()
        expect(cancelEdit.mock.calls[0][0].key).toBe('Escape')
    })

    it('reports an unhandled Escape', () => {
        focusedInput()
        expect(requestEscapeAction()).toBe(false)
    })

    it('recognizes native and contenteditable text entry elements', () => {
        const contenteditable = document.createElement('div')
        contenteditable.contentEditable = 'true'

        expect(isTextEntryElement(document.createElement('input'))).toBe(true)
        expect(isTextEntryElement(document.createElement('textarea'))).toBe(true)
        expect(isTextEntryElement(contenteditable)).toBe(true)
        expect(isTextEntryElement(document.createElement('button'))).toBe(false)
        const checkbox = document.createElement('input')
        checkbox.type = 'checkbox'
        expect(isTextEntryElement(checkbox)).toBe(false)
    })

    it('requests close through the topmost eligible action in a scope', () => {
        const scope = document.createElement('div')
        const first = document.createElement('button')
        const last = document.createElement('button')
        first.dataset.risuDialogClose = ''
        last.dataset.risuDialogClose = ''
        const firstClose = vi.fn()
        const lastClose = vi.fn()
        first.addEventListener('click', firstClose)
        last.addEventListener('click', lastClose)
        scope.append(first, last)

        expect(requestDialogCloseAction(scope)).toBe(true)
        expect(firstClose).not.toHaveBeenCalled()
        expect(lastClose).toHaveBeenCalledOnce()
    })
})
