import { afterEach, describe, expect, it, vi } from 'vitest'
import { createPopupEditorCommitController } from './popupEditorCommit'

afterEach(() => vi.useRealTimers())

describe('popup editor commit controller', () => {
    it('defers debounce updates through the shared draft writer', async () => {
        vi.useFakeTimers()
        const commit = vi.fn()
        const controller = createPopupEditorCommitController(commit, () => 250)

        controller.update('next', 'debounce')
        expect(commit).not.toHaveBeenCalled()
        await vi.runAllTimersAsync()
        expect(commit).toHaveBeenCalledOnce()
        expect(commit).toHaveBeenCalledWith('next')
    })

    it('keeps submit updates local until flush', async () => {
        vi.useFakeTimers()
        const commit = vi.fn().mockReturnValue(true)
        const controller = createPopupEditorCommitController(commit, () => 250)

        controller.update('next', 'submit')
        await vi.runAllTimersAsync()
        expect(commit).not.toHaveBeenCalled()
        await expect(controller.flush('next', 'submit')).resolves.toBe(true)
        expect(commit).toHaveBeenCalledOnce()
    })
})
