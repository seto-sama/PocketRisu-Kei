import { applyPatch } from 'fast-json-patch'
import isEqual from 'lodash/isEqual'
import { safeStructuredClone } from '../polyfill'

// Stable identity fields used by persisted characters, entities, and messages.
const identityKeys = ['chaId', 'id', 'chatId'] as const
const isObject = (value: any) => value !== null && typeof value === 'object' && !Array.isArray(value)

function mergeLocalChanges(base: any, local: any, server: any): any {
    if (isEqual(base, local)) return server
    if (Array.isArray(local) && Array.isArray(server) && Array.isArray(base)) {
        const lists = [base, local, server]
        const identity = identityKeys.find(key =>
            lists.some(list => list.length > 0) && lists.every(list =>
                list.every(item => typeof item?.[key] === 'string' && item[key])))
        if (identity) {
            const byId = (list: any[]) => new Map(list.map(item => [item[identity], item]))
            const before = byId(base), ours = byId(local), theirs = byId(server)
            const merged = new Map<string, any>()
            for (const [id, item] of ours) {
                // Preserve a server deletion unless this client edited the item.
                if (before.has(id) && !theirs.has(id) && isEqual(before.get(id), item)) continue
                merged.set(id, mergeLocalChanges(before.get(id), item, theirs.get(id)))
            }
            // Retain concurrent server additions, excluding acknowledged local
            // additions and intentional local deletions. Local ordering wins.
            for (const [id, item] of theirs) {
                if (!before.has(id) && !ours.has(id)) merged.set(id, item)
            }
            if (isEqual([...before.keys()], [...ours.keys()])) {
                // Editing a field is not an instruction to undo another
                // client's reorder or reposition its newly inserted items.
                const order = [...theirs.keys(), ...merged.keys()]
                return [...new Set(order)].filter(id => merged.has(id)).map(id => merged.get(id))
            }
            return [...merged.values()]
        }
    }
    if (isObject(local) && isObject(server) && (base === undefined || isObject(base))) {
        const result = { ...server }
        for (const key of new Set([...Object.keys(base ?? {}), ...Object.keys(local)])) {
            if (Object.hasOwn(base ?? {}, key) === Object.hasOwn(local, key)
                && isEqual(base?.[key], local[key])) continue
            if (!Object.hasOwn(local, key)) delete result[key]
            else result[key] = mergeLocalChanges(base?.[key], local[key], server[key])
        }
        return result
    }
    return local
}

/**
 * Preserve the exact server pre-image used by the hash protocol while replaying
 * rejected local operations into a separate live state. The replayed state is
 * still pending and must never be installed as the patcher's synced baseline.
 */
export function preparePatchConflictRebase<T>(
    latestServerValue: T,
    rejected?: { patch: any[], baseline: T },
): { serverBaseline: T, mergedValue: T } {
    const serverBaseline = safeStructuredClone(latestServerValue)
    let mergedValue = safeStructuredClone(latestServerValue)
    if (rejected) {
        // Array offsets belong to the rejected patch's original pre-image.
        // Replaying directly on the server list can duplicate additions or
        // overwrite another item after a concurrent insertion/reorder.
        const target = safeStructuredClone(rejected.baseline)
        const local = applyPatch(target as object, safeStructuredClone(rejected.patch), true).newDocument
        mergedValue = mergeLocalChanges(rejected.baseline, local, mergedValue)
    }
    return { serverBaseline, mergedValue }
}
