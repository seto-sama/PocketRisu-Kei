import { applyPatch } from 'fast-json-patch'
import { safeStructuredClone } from '../polyfill'

/**
 * Preserve the exact server pre-image used by the hash protocol while replaying
 * rejected local operations into a separate live state. The replayed state is
 * still pending and must never be installed as the patcher's synced baseline.
 */
export function preparePatchConflictRebase<T>(
    latestServerValue: T,
    rejectedPatch?: any[],
): { serverBaseline: T, mergedValue: T } {
    const serverBaseline = safeStructuredClone(latestServerValue)
    const mergedValue = safeStructuredClone(latestServerValue)
    if (rejectedPatch) {
        applyPatch(mergedValue as object, safeStructuredClone(rejectedPatch), true)
    }
    return { serverBaseline, mergedValue }
}
