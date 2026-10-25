import type { Rect } from '@codemirror/view'

export function getCompletionViewport(target: HTMLElement): Rect {
    const window = target.ownerDocument.defaultView!
    const viewport = window.visualViewport
    const left = viewport?.offsetLeft ?? 0
    const top = viewport?.offsetTop ?? 0
    const right = left + (viewport?.width ?? window.innerWidth)
    return { left, right, top, bottom: top + (viewport?.height ?? window.innerHeight) }
}

export function getCompletionBounds(target: HTMLElement): Rect {
    const rect = target.getBoundingClientRect()
    const viewport = getCompletionViewport(target)
    const left = Math.min(viewport.right, Math.max(rect.left, viewport.left))
    return { ...viewport, left, right: Math.max(left, Math.min(rect.right, viewport.right)) }
}

export function getCompletionAnchor(bounds: Rect, tagStart: Rect, caret: Rect, lineHeight = caret.bottom - caret.top): DOMRect {
    const top = caret.top - (lineHeight - (caret.bottom - caret.top)) / 2
    return new DOMRect(Math.max(bounds.left, Math.min(tagStart.left, bounds.right)), top, 0, lineHeight)
}
