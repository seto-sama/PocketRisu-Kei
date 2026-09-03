import { createDebouncedDraftWriter } from './storage/draftPersistence'

export type PopupEditorCommitMode = 'input' | 'debounce' | 'submit'
export type PopupEditorCommitResult = void | boolean

export function createPopupEditorCommitController(
    commit: (value: string) => PopupEditorCommitResult | Promise<PopupEditorCommitResult>,
    debounceMs: () => number,
) {
    const pendingInputCommits = new Set<Promise<void>>()
    const runCommit = async (value: string) => commit(value)
    const debouncedWriter = createDebouncedDraftWriter<string>(async (value) => {
        await runCommit(value)
    }, debounceMs)

    function update(value: string, mode: PopupEditorCommitMode) {
        if (mode === 'input') {
            debouncedWriter.cancel()
            const pending = runCommit(value).then(() => {}).catch(() => {})
            pendingInputCommits.add(pending)
            void pending.finally(() => pendingInputCommits.delete(pending))
        } else if (mode === 'debounce') {
            debouncedWriter.schedule(value)
        }
    }

    async function flush(value: string, mode: PopupEditorCommitMode): Promise<PopupEditorCommitResult> {
        if (mode === 'submit') return runCommit(value)
        if (mode === 'debounce') {
            await debouncedWriter.flush(value)
            return
        }
        await Promise.all([...pendingInputCommits])
    }

    return {
        update,
        flush,
        cancel: debouncedWriter.cancel,
    }
}
