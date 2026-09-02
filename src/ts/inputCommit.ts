export type InputCommitMode = 'input' | 'debounce' | 'blur'

// Keep editor-side work (DB commits, token counts, previews) on the same
// cadence so a short pause in typing produces one coherent update without
// making the UI feel delayed.
export const INPUT_COMMIT_DEBOUNCE_MS = 250

export function resolveInputCommitMode(
    mode: InputCommitMode | undefined,
    legacyOptimized?: boolean,
): InputCommitMode {
    if (mode) return mode
    if (legacyOptimized === undefined) return 'input'
    return legacyOptimized ? 'debounce' : 'input'
}
