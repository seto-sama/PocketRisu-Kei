import { expect, it, vi } from 'vitest'
import { getCompletionAnchor, getCompletionBounds } from './completionPlacement'

it('anchors to the tag start horizontally and the bottom of the current caret line vertically', () => {
    const bounds = { left: 100, right: 500, top: 0, bottom: 800 }
    const start = new DOMRect(380, 40, 0, 18)
    const caret = new DOMRect(160, 70, 0, 18)
    const anchor = getCompletionAnchor(bounds, start, caret, 26)
    expect(anchor.left).toBe(380)
    expect(anchor.top).toBe(66)
    expect(anchor.bottom).toBe(92)
    // A native textarea already supplies the full line box.
    expect(getCompletionAnchor(bounds, start, new DOMRect(160, 66, 0, 26)).toJSON()).toEqual(anchor.toJSON())
})

it('keeps the horizontal bounds tied to the input while allowing the popup outside it vertically', () => {
    const target = document.createElement('textarea')
    vi.spyOn(target, 'getBoundingClientRect').mockReturnValue(new DOMRect(100, 200, 360, 80))
    const bounds = getCompletionBounds(target)
    expect(bounds).toEqual({ left: 100, right: 460, top: 0, bottom: window.innerHeight })
    expect(getCompletionAnchor(bounds, new DOMRect(70, 210, 0, 20), new DOMRect(300, 250, 0, 20)).left).toBe(100)
    expect(getCompletionAnchor(bounds, new DOMRect(490, 210, 0, 20), new DOMRect(300, 250, 0, 20)).left).toBe(460)
})

it('limits a partially offscreen input to its visible width', () => {
    const target = document.createElement('textarea')
    vi.spyOn(target, 'getBoundingClientRect').mockReturnValue(new DOMRect(-20, 100, 320, 80))
    expect(getCompletionBounds(target)).toMatchObject({ left: 0, right: 300 })
    vi.spyOn(target, 'getBoundingClientRect').mockReturnValue(new DOMRect(window.innerWidth - 200, 100, 320, 80))
    expect(getCompletionBounds(target)).toMatchObject({ left: window.innerWidth - 200, right: window.innerWidth })
})
