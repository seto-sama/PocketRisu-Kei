import { afterEach, describe, expect, it, vi } from 'vitest'
import { requestEscapeAction } from './escapeKey'

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
})
