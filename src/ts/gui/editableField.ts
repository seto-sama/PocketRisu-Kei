import type { Attachment } from 'svelte/attachments'

const TEXT_INPUT_TYPES = new Set(['text', 'search', 'url', 'tel', 'email', ''])

/** Dispatched on a field to ask the component that owns it to open the popup editor. */
export const POPUP_EDITOR_REQUEST_EVENT = 'pocketrisu:popup-editor-request'

export function textInputOf(element: Element | null): HTMLTextAreaElement | HTMLInputElement | null {
    if (element instanceof HTMLTextAreaElement) return element
    if (element instanceof HTMLInputElement && TEXT_INPUT_TYPES.has(element.type)) return element
    return null
}

function writable(element: HTMLElement | null): HTMLElement | null {
    const input = textInputOf(element)
    if (input) return input.readOnly || input.disabled ? null : input
    return element?.isContentEditable ? element : null
}

export function focusedEditableField(): HTMLElement | null {
    return writable(document.activeElement as HTMLElement | null)
}

/** The focused field, else the field under a touch (the mobile keyboard may be closed). */
export function editableFieldFor(target: EventTarget | null): HTMLElement | null {
    const touched = target instanceof Element
        ? target.closest<HTMLElement>('textarea, input, [contenteditable]')
        : null
    return focusedEditableField() ?? writable(touched)
}

/** Returns whether a component took the request; plain fields have no popup editor. */
export function requestPopupEditor(field: HTMLElement | null): boolean {
    if (!field) return false
    return !field.dispatchEvent(new CustomEvent(POPUP_EDITOR_REQUEST_EVENT, { cancelable: true }))
}

export function onPopupEditorRequest(open: () => void): Attachment<HTMLElement> {
    return (field) => {
        const handle = (event: Event) => {
            event.preventDefault()
            open()
        }
        field.addEventListener(POPUP_EDITOR_REQUEST_EVENT, handle)
        return () => field.removeEventListener(POPUP_EDITOR_REQUEST_EVENT, handle)
    }
}
