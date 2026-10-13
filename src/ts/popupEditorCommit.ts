import { createDebouncedDraftWriter } from './storage/draftPersistence'

export type PopupEditorCommitMode = 'debounce' | 'submit'
export type PopupEditorCommitResult = void | boolean

export function createPopupEditorCommitController(
    commit: (value: string) => PopupEditorCommitResult | Promise<PopupEditorCommitResult>,
    debounceMs: () => number,
) {
    const debouncedWriter = createDebouncedDraftWriter<string>(async (value) => {
        await commit(value)
    }, debounceMs)

    function update(value: string, mode: PopupEditorCommitMode) {
        if (mode === 'debounce') debouncedWriter.schedule(value)
    }

    async function flush(value: string, mode: PopupEditorCommitMode): Promise<PopupEditorCommitResult> {
        if (mode === 'submit') return commit(value)
        await debouncedWriter.flush(value)
    }

    return {
        update,
        flush,
        cancel: debouncedWriter.cancel,
    }
}
