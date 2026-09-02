import { describe, expect, it, vi } from 'vitest'
import {
    cancelOnOutputRepetition,
    normalizeOutputRepetitionLimit,
    OutputRepetitionDetector,
} from './repetitionDetector'

describe('OutputRepetitionDetector', () => {
    it('normalizes enabled limits and preserves the disabled state', () => {
        expect(normalizeOutputRepetitionLimit(-1000)).toBeUndefined()
        expect(normalizeOutputRepetitionLimit(3.9)).toBe(3)
        expect(normalizeOutputRepetitionLimit(99)).toBe(16)
    })

    it('detects repeated sentences across token snapshot boundaries', () => {
        const detector = new OutputRepetitionDetector(2)
        expect(detector.update('다시 말')).toBeNull()
        expect(detector.update('다시 말합니다. 다시 말합니다.')).toBeNull()
        expect(detector.update('다시 말합니다. 다시 말합니다. 다시 말합니다.')).toEqual({
            blockSize: 1,
            repeats: 2,
        })
    })

    it('detects a repeating multi-unit pattern', () => {
        const detector = new OutputRepetitionDetector(1)
        expect(detector.update('A. B. A. B.')).toEqual({ blockSize: 2, repeats: 1 })
    })

    it('uses newlines as boundaries and ignores unfinished tails', () => {
        const detector = new OutputRepetitionDetector(1)
        expect(detector.update('same\nsame')).toBeNull()
        expect(detector.update('same\nsame\n')).toEqual({ blockSize: 1, repeats: 1 })
    })

    it('does not rescan an unchanged completed suffix for partial token updates', () => {
        const detector = new OutputRepetitionDetector(1)
        expect(detector.update('same.')).toBeNull()
        expect(detector.update('same. partial')).toBeNull()
        expect(detector.update('same. partial text')).toBeNull()
    })

    it('ignores quotation marks adjacent to sentence boundaries', () => {
        const detector = new OutputRepetitionDetector(1)
        expect(detector.update('“Hello.” “Hello.”')).toEqual({ blockSize: 1, repeats: 1 })
    })

    it('resets when a provider replaces rather than extends its snapshot', () => {
        const detector = new OutputRepetitionDetector(1)
        expect(detector.update('old.')).toBeNull()
        expect(detector.update('new. new.')).toEqual({ blockSize: 1, repeats: 1 })
    })
})

describe('cancelOnOutputRepetition', () => {
    it('delivers the triggering snapshot and cancels the source', async () => {
        const cancel = vi.fn()
        const detected = vi.fn()
        const source = new ReadableStream<Record<string, string>>({
            start(controller) {
                controller.enqueue({ '0': 'loop. loop.' })
            },
            cancel,
        })
        const reader = cancelOnOutputRepetition(source, 1, detected).getReader()

        await expect(reader.read()).resolves.toEqual({
            done: false,
            value: { '0': 'loop. loop.' },
        })
        await expect(reader.read()).resolves.toEqual({ done: true, value: undefined })
        expect(cancel).toHaveBeenCalledWith('Output repetition detected')
        expect(detected).toHaveBeenCalledOnce()
    })

    it('detects repetition while the moving Thoughts wrapper is being updated', async () => {
        const cancel = vi.fn()
        const detected = vi.fn()
        const source = new ReadableStream<Record<string, string>>({
            start(controller) {
                controller.enqueue({ '0': '<Thoughts>\nloop.\n</Thoughts>\n\n' })
                controller.enqueue({ '0': '<Thoughts>\nloop. loop.\n</Thoughts>\n\n' })
            },
            cancel,
        })
        const reader = cancelOnOutputRepetition(source, 1, detected).getReader()

        expect((await reader.read()).done).toBe(false)
        expect((await reader.read()).done).toBe(false)
        await expect(reader.read()).resolves.toEqual({ done: true, value: undefined })
        expect(cancel).toHaveBeenCalledWith('Output repetition detected')
        expect(detected).toHaveBeenCalledOnce()
    })
})
