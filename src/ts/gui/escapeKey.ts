const TEXT_INPUT_TYPES = new Set(['text', 'search', 'email', 'url', 'tel', 'password', 'number'])

/**
 * Sends Escape through the normal focused-element event path.
 * Closing, cancelling edits, and blocking dismissal all consume Escape via
 * preventDefault(). Only an unconsumed event may fall through to navigation.
 */
export function requestEscapeAction(): boolean {
    const event = new KeyboardEvent('keydown', {
        key: 'Escape',
        code: 'Escape',
        bubbles: true,
        cancelable: true,
    })
    const target = document.activeElement instanceof HTMLElement
        ? document.activeElement
        : document.body
    return !target.dispatchEvent(event)
}

export function isTextEntryElement(element: Element | null): element is HTMLElement {
    if (!(element instanceof HTMLElement)) return false
    if (element instanceof HTMLTextAreaElement || element.isContentEditable) return true
    if (!(element instanceof HTMLInputElement)) return false
    return TEXT_INPUT_TYPES.has(element.type)
}

/** Invokes the same action as the visible close control in a dialog-like UI. */
export function requestDialogCloseAction(scope: ParentNode = document): boolean {
    const actions = scope.querySelectorAll<HTMLButtonElement>('[data-risu-dialog-close]')
    // Portaled/nested layers are appended after their parents, so search from
    // the end and stop at the first action that can currently be used.
    for (let index = actions.length - 1; index >= 0; index--) {
        const action = actions[index]
        if (action.disabled || action.closest('[hidden], [inert], [aria-hidden="true"], [data-state="closed"]')) continue
        action.click()
        return true
    }
    return false
}
