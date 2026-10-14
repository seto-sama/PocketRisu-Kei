const textLayoutProperties = [
    'font-family', 'font-size', 'font-weight', 'font-style', 'font-variant',
    'line-height', 'letter-spacing', 'word-spacing', 'text-transform', 'text-indent',
    'text-align', 'direction', 'tab-size', 'padding-top', 'padding-right',
    'padding-bottom', 'padding-left',
]

/** Measure the caret with the textarea's font, wrapping and scroll offsets. */
export function getTextareaCaretRect(target: HTMLTextAreaElement, position = target.selectionStart): DOMRect {
    const document = target.ownerDocument
    const computed = document.defaultView!.getComputedStyle(target)
    const mirror = document.createElement('div')
    mirror.style.cssText = 'position:fixed;top:0;left:0;visibility:hidden;pointer-events:none;box-sizing:border-box;border:0;margin:0;'
    for (const property of textLayoutProperties) mirror.style.setProperty(property, computed.getPropertyValue(property))
    mirror.style.width = `${target.clientWidth}px`
    mirror.style.whiteSpace = target.wrap === 'off' ? 'pre' : 'pre-wrap'
    mirror.style.overflowWrap = target.wrap === 'off' ? 'normal' : 'break-word'
    mirror.textContent = target.value.slice(0, position)
    const marker = document.createElement('span')
    marker.textContent = target.value.slice(position) || '.'
    mirror.append(marker)
    document.body.append(mirror)
    try {
        const bounds = target.getBoundingClientRect()
        const characterHeight = marker.getClientRects()[0]?.height || parseFloat(computed.fontSize)
        const height = parseFloat(computed.lineHeight) || characterHeight
        return new DOMRect(
            bounds.left + target.clientLeft + marker.offsetLeft - target.scrollLeft,
            bounds.top + target.clientTop + marker.offsetTop - target.scrollTop - (height - characterHeight) / 2,
            0,
            height,
        )
    } finally { mirror.remove() }
}
