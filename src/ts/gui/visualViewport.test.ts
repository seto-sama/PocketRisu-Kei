import { afterEach, describe, expect, it } from 'vitest'
import { getVisualViewportBounds } from './visualViewport'

const originalVisualViewport = Object.getOwnPropertyDescriptor(window, 'visualViewport')

afterEach(() => {
    if (originalVisualViewport) {
        Object.defineProperty(window, 'visualViewport', originalVisualViewport)
    } else {
        Reflect.deleteProperty(window, 'visualViewport')
    }
})

describe('getVisualViewportBounds', () => {
    it('falls back to the layout viewport', () => {
        Object.defineProperty(window, 'visualViewport', {
            configurable: true,
            value: undefined,
        })

        expect(getVisualViewportBounds()).toEqual({
            top: 0,
            left: 0,
            right: window.innerWidth,
            bottom: window.innerHeight,
            width: window.innerWidth,
            height: window.innerHeight,
            layoutWidth: window.innerWidth,
            layoutHeight: window.innerHeight,
        })
    })

    it('uses the visible viewport offsets and dimensions', () => {
        Object.defineProperty(window, 'visualViewport', {
            configurable: true,
            value: {
                offsetTop: 24,
                offsetLeft: 12,
                width: 360,
                height: 640,
            },
        })

        expect(getVisualViewportBounds()).toMatchObject({
            top: 24,
            left: 12,
            right: 372,
            bottom: 664,
            width: 360,
            height: 640,
        })
    })
})
