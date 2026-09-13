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
