import { applyPatch } from 'fast-json-patch'
import isEqual from 'fast-deep-equal'
import { applyDelta, createDelta } from '../../../shared/guardedDelta.mjs'

// Stable identity fields used by persisted characters, entities, and messages.
const identityKeys = ['chaId', 'id', 'chatId'] as const
const isObject = (value: any) => value !== null && typeof value === 'object' && !Array.isArray(value)

export type MergePath = Array<string | { key: string, value: string }>
export type MergeConflict = { path: MergePath, base: any, local: any, server: any, kind?: 'order' }
export type ConflictChoice = 'local' | 'server'
type ConflictResolver = (conflict: MergeConflict) => ConflictChoice

function resolveValue(base: any, local: any, server: any, path: MergePath, resolve?: ConflictResolver) {
    if (isEqual(base, local)) return server
    if (isEqual(base, server) || isEqual(local, server)) return local
    return resolve?.({ path, base, local, server }) === 'server' ? server : local
}

function resolveArrayOrder(before: Map<string, any>, ours: Map<string, any>, theirs: Map<string, any>, merged: Map<string, any>, path: MergePath, resolve: ConflictResolver) {
    const ids = (items: Map<string, any>) => ({ items: [...items.keys()].map(id => ({ id })) })
    const serverIds = [...theirs.keys()]
    const present = new Set(serverIds)
    const changes = createDelta(ids(before), ids(ours)).filter(change => {
        if (change.kind !== 'order') {
            const id = change.path.at(-1).value
            return change.after.exists ? merged.has(id) : !merged.has(id)
        }
        const ordered = new Set(change.before)
        const current = serverIds.filter(id => ordered.has(id))
        const oldOrder = change.before.filter(id => present.has(id))
        const newOrder = change.after.filter(id => present.has(id))
        if (isEqual(current, oldOrder) || isEqual(current, newOrder)) return true
        if (resolve({ path, base: oldOrder, local: newOrder, server: current, kind: 'order' }) === 'server') return false
        change.before = [...current, ...change.before.filter(id => !present.has(id))]
        return true
    })
    const ordered = applyDelta(ids(theirs), changes).items.map(item => item.id)
    return [...new Set([...ordered, ...merged.keys()])].filter(id => merged.has(id)).map(id => merged.get(id))
}

function mergeLocalChanges(
    base: any, local: any, server: any, atomicMessages = false,
    resolveConflict?: ConflictResolver, path: MergePath = [],
): any {
    if (isEqual(base, local)) return server
    if (resolveConflict && (isEqual(base, server) || isEqual(local, server))) return local
    if (Array.isArray(local) && Array.isArray(server) && (base === undefined || Array.isArray(base))) {
        const lists = [base ?? [], local, server]
        const identity = identityKeys.find(key =>
            lists.some(list => list.length > 0) && lists.every(list =>
                list.every(item => typeof item?.[key] === 'string' && item[key])))
        if (identity) {
            const byId = (list: any[]) => new Map(list.map(item => [item[identity], item]))
            const before = byId(base ?? []), ours = byId(local), theirs = byId(server)
            const merged = new Map<string, any>()
            for (const [id, item] of ours) {
                // Preserve a server deletion unless this client edited the item.
                if (before.has(id) && !theirs.has(id) && isEqual(before.get(id), item)) continue
                const itemPath = [...path, { key: identity, value: id }]
                const value = identity === 'chatId' && atomicMessages
                    ? resolveValue(before.get(id), item, theirs.get(id), itemPath, resolveConflict)
                    : mergeLocalChanges(before.get(id), item, theirs.get(id), atomicMessages, resolveConflict, itemPath)
                if (value !== undefined) merged.set(id, value)
            }
            if (resolveConflict) {
                for (const [id, item] of before) {
                    if (ours.has(id) || !theirs.has(id) || isEqual(item, theirs.get(id))) continue
                    if (resolveConflict({ path: [...path, { key: identity, value: id }], base: item, local: undefined, server: theirs.get(id) }) === 'server') {
                        merged.set(id, theirs.get(id))
                    }
                }
            }
            // Retain concurrent server additions, excluding acknowledged local
            // additions and intentional local deletions. Local ordering wins.
            for (const [id, item] of theirs) {
                if (!before.has(id) && !ours.has(id)) merged.set(id, item)
            }
            if (resolveConflict) return resolveArrayOrder(before, ours, theirs, merged, path, resolveConflict)
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
            if (!Object.hasOwn(local, key) && !resolveConflict) delete result[key]
            else {
                const value = mergeLocalChanges(base?.[key], local[key], server[key], atomicMessages, resolveConflict, [...path, key])
                if (value === undefined) delete result[key]
                else Object.defineProperty(result, key, { value, enumerable: true, configurable: true, writable: true })
            }
        }
        return result
    }
    return resolveValue(base, local, server, path, resolveConflict)
}

/** Resolve only overlapping edits; unrelated changes from both sides remain. */
export function mergeWithConflictChoices<T>(base: T | undefined, local: T, server: T, resolve: ConflictResolver): T {
    return structuredClone(mergeLocalChanges(base, local, server, true, resolve)) as T
}

/** Retain local intent in the UI and pin its original pre-images for guarded saves. */
export function reconcilePendingChanges<T>(base: T, local: T, server: T, atomicMessages = false) {
    return {
        mergedValue: structuredClone(mergeLocalChanges(base, local, server, atomicMessages)) as T,
        baseline: structuredClone(mergeLocalChanges(local, base, server, atomicMessages)) as T,
    }
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
    const serverBaseline = structuredClone(latestServerValue)
    let mergedValue = structuredClone(latestServerValue)
    if (rejected) {
        // Array offsets belong to the rejected patch's original pre-image.
        // Replaying directly on the server list can duplicate additions or
        // overwrite another item after a concurrent insertion/reorder.
        const target = structuredClone(rejected.baseline)
        const local = applyPatch(target as object, structuredClone(rejected.patch), true).newDocument
        mergedValue = mergeLocalChanges(rejected.baseline, local, mergedValue)
    }
    return { serverBaseline, mergedValue }
}
