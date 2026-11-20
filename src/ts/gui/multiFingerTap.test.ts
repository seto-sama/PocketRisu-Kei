import { afterEach, describe, expect, it, vi } from 'vitest'
import { installMultiFingerTap } from './multiFingerTap'

type Point = { id: number, x: number, y: number }

function touchEvent(type: string, changed: Point[], active: Point[]) {
    const event = new Event(type, { bubbles: true, cancelable: true })
    const list = (points: Point[]) => points.map(p => ({ identifier: p.id, clientX: p.x, clientY: p.y }))
    Object.defineProperty(event, 'changedTouches', { value: list(changed) })
    Object.defineProperty(event, 'touches', { value: list(active) })
    return event
}

function tap(fingers: number, dragFirstBy = 0) {
    const points = Array.from({ length: fingers }, (_, id) => ({ id, x: id * 40, y: 0 }))
    points.forEach((point, index) => {
        document.body.dispatchEvent(touchEvent('touchstart', [point], points.slice(0, index + 1)))
    })
    if (dragFirstBy) {
        document.body.dispatchEvent(touchEvent('touchmove', [{ ...points[0], y: dragFirstBy }], points))
    }
    points.forEach((point, index) => {
        document.body.dispatchEvent(touchEvent('touchend', [point], points.slice(index + 1)))
    })
}

let uninstall: (() => void) | undefined

afterEach(() => uninstall?.())

describe('installMultiFingerTap', () => {
    it('reports the finger count once, after every finger lifts', () => {
        const onTap = vi.fn((_fingers: number, _target: EventTarget | null) => true)
        uninstall = installMultiFingerTap(onTap)

        tap(4)
        tap(3)
        tap(2)

        expect(onTap.mock.calls.map(([fingers]) => fingers)).toEqual([4, 3, 2])
    })

    it('ignores single touches, moved taps like pinch or scroll, and cancelled taps', () => {
        const onTap = vi.fn((_fingers: number, _target: EventTarget | null) => true)
        uninstall = installMultiFingerTap(onTap)

        tap(1)
        tap(2, 40)
        // The browser cancels one of two contacts; the other lifting normally is no tap.
        const [first, second] = [{ id: 0, x: 0, y: 0 }, { id: 1, x: 40, y: 0 }]
        document.body.dispatchEvent(touchEvent('touchstart', [first, second], [first, second]))
        document.body.dispatchEvent(touchEvent('touchcancel', [first], [second]))
        document.body.dispatchEvent(touchEvent('touchend', [second], []))

        expect(onTap).not.toHaveBeenCalled()
    })
})
