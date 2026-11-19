const IDENTITY_KEYS = ['chaId', 'chatId', 'id']
// characterOrder lists a character as its bare id string and a folder as an object; an entry
// there, or in a folder's own id list, is identified by the string itself or the folder's id.
const ENTRY_IDENTITY = '$entry'
const SELECTOR_KEYS = [...IDENTITY_KEYS, ENTRY_IDENTITY]
const UNSAFE_PATH_KEYS = new Set(['__proto__', 'prototype', 'constructor'])

export class DeltaConflictError extends Error {
    constructor(conflicts) {
        super('Delta conflicts with the current value')
        this.name = 'DeltaConflictError'
        this.conflicts = conflicts
    }
}

export class DeltaValidationError extends Error {
    constructor(message) {
        super(message)
        this.name = 'DeltaValidationError'
    }
}

class MissingTarget extends Error {}

function isPlainObject(value) {
    if (value === null || typeof value !== 'object') return false
    const prototype = Object.getPrototypeOf(value)
    return prototype === Object.prototype || prototype === null
}

function hasOwn(value, key) {
    return Object.prototype.hasOwnProperty.call(value, key)
}

function cloneJson(value) {
    if (Array.isArray(value)) return value.map(cloneJson)
    if (!isPlainObject(value)) return value
    const clone = {}
    for (const key of Object.keys(value)) {
        Object.defineProperty(clone, key, {
            value: cloneJson(value[key]), enumerable: true, configurable: true, writable: true,
        })
    }
    return clone
}

export function valuesEqual(left, right) {
    if (left === right) return true
    if (left === null || right === null || typeof left !== 'object' || typeof right !== 'object') return false
    if (Array.isArray(left) !== Array.isArray(right)) return false
    if (Array.isArray(left) && left.length !== right.length) return false
    const leftKeys = Object.keys(left)
    const rightKeys = Object.keys(right)
    if (leftKeys.length !== rightKeys.length) return false
    for (const key of leftKeys) {
        if (!hasOwn(right, key) || !valuesEqual(left[key], right[key])) return false
    }
    return true
}

export function identityFor(item, key) {
    if (key === ENTRY_IDENTITY) {
        if (typeof item === 'string') return item.length > 0 ? item : undefined
        key = 'id'
    }
    if (!isPlainObject(item) || !hasOwn(item, key)) return undefined
    const id = item[key]
    return typeof id === 'string' && id.length > 0 ? id : undefined
}

function hasUniqueIdentity(items, key) {
    if (items.length === 0) return true
    const ids = new Set()
    for (const item of items) {
        const id = identityFor(item, key)
        if (id === undefined || ids.has(id)) return false
        ids.add(id)
    }
    return true
}

function usesEntryIdentity(path) {
    return path[0] === 'characterOrder' && (path.length === 1
        || (path.length === 3 && typeof path[1] === 'object' && path[2] === 'data'))
}

function detectIdentity(before, after, path = []) {
    for (const key of usesEntryIdentity(path) ? [ENTRY_IDENTITY] : IDENTITY_KEYS) {
        if (hasUniqueIdentity(before, key) && hasUniqueIdentity(after, key)
            && (before.length > 0 || after.length > 0)) return key
    }
    return undefined
}

function pathWith(path, part) {
    return [...path, part]
}

function selector(identity, value) {
    return { key: identity, value }
}

function snapshot(exists, value) {
    return exists ? { exists: true, value: cloneJson(value) } : { exists: false }
}

function addValueChange(changes, path, beforeExists, before, afterExists, after, placement) {
    const change = {
        kind: 'value',
        path: cloneJson(path),
        before: snapshot(beforeExists, before),
        after: snapshot(afterExists, after),
    }
    if (placement) change.placement = cloneJson(placement)
    changes.push(change)
}

function diffValue(beforeExists, before, afterExists, after, path, changes, context) {
    if (beforeExists === afterExists && (!beforeExists || valuesEqual(before, after))) return

    if (!beforeExists || !afterExists) {
        addValueChange(changes, path, beforeExists, before, afterExists, after)
        return
    }

    if (isPlainObject(before) && isPlainObject(after)) {
        const keys = new Set([...Object.keys(before), ...Object.keys(after)])
        for (const key of keys) {
            if (path.length === 0 && context.ignoredRootKeys.has(key)) continue
            if (UNSAFE_PATH_KEYS.has(key)
                && (hasOwn(before, key) !== hasOwn(after, key)
                    || (hasOwn(before, key) && !valuesEqual(before[key], after[key])))) {
                throw new DeltaValidationError(`unsafe path key: ${key}`)
            }
            diffValue(
                hasOwn(before, key), before[key], hasOwn(after, key), after[key],
                pathWith(path, key), changes, context,
            )
        }
        return
    }

    if (Array.isArray(before) && Array.isArray(after)) {
        const identity = detectIdentity(before, after, path)
        if (!identity) {
            addValueChange(changes, path, true, before, true, after)
            return
        }

        const ignored = identity === 'chatId' ? context.ignoredMessageIds : new Set()
        const beforeIds = before.map(item => identityFor(item, identity)).filter(id => id !== undefined && !ignored.has(id))
        const editedItems = after.filter(item => !ignored.has(identityFor(item, identity)))
        const afterIds = editedItems.map(item => identityFor(item, identity))
        const beforeById = new Map(before.filter(item => !ignored.has(identityFor(item, identity))).map(item => [identityFor(item, identity), item]))
        const afterById = new Map(editedItems.map(item => [identityFor(item, identity), item]))

        for (const id of beforeIds) {
            const itemPath = pathWith(path, selector(identity, id))
            if (!afterById.has(id)) {
                addValueChange(changes, itemPath, true, beforeById.get(id), false, undefined)
            } else {
                const oldItem = beforeById.get(id)
                const newItem = afterById.get(id)
                if (!valuesEqual(oldItem, newItem)) {
                    if (identity === 'chatId') {
                        addValueChange(changes, itemPath, true, oldItem, true, newItem)
                    } else {
                        diffValue(true, oldItem, true, newItem, itemPath, changes, context)
                    }
                }
            }
        }

        const retained = new Set(beforeIds.filter(id => afterById.has(id)))
        const afterOrder = afterIds.filter(id => retained.has(id))
        const additions = []
        let afterAnchor
        let nextRetained = 0
        for (const id of afterIds) {
            if (beforeById.has(id)) {
                afterAnchor = id
                nextRetained++
                continue
            }
            const beforeAnchor = afterOrder[nextRetained]
            const placement = afterAnchor === undefined && beforeAnchor === undefined ? undefined : {
                ...(afterAnchor === undefined ? {} : { after: afterAnchor }),
                ...(beforeAnchor === undefined ? {} : { before: beforeAnchor }),
            }
            addValueChange(
                additions,
                pathWith(path, selector(identity, id)),
                false, undefined, true, afterById.get(id),
                placement,
            )
            afterAnchor = id
        }

        const beforeOrder = beforeIds.filter(id => retained.has(id))
        if (!valuesEqual(beforeOrder, afterOrder)) {
            changes.push({
                kind: 'order', path: cloneJson(path), identity,
                before: beforeOrder, after: afterOrder,
            })
        }
        for (const addition of additions) changes.push(addition)
        return
    }

    addValueChange(changes, path, true, before, true, after)
}

export function createDelta(base, edited, options = {}) {
    return diffAt([], base, edited, options)
}

function diffAt(path, base, edited, options = {}) {
    const changes = []
    diffValue(
        base !== undefined, base, edited !== undefined, edited, path, changes,
        {
            ignoredRootKeys: new Set(options.ignoredRootKeys ?? []),
            ignoredMessageIds: new Set(options.ignoredMessageIds ?? []),
        },
    )
    return changes
}

function validation(message) {
    throw new DeltaValidationError(message)
}

function validatePath(path) {
    if (!Array.isArray(path)) validation('change path must be an array')
    for (const part of path) {
        if (typeof part === 'string') {
            if (UNSAFE_PATH_KEYS.has(part)) validation(`unsafe path key: ${part}`)
            continue
        }
        if (!isPlainObject(part) || Object.keys(part).length !== 2
            || !hasOwn(part, 'key') || !hasOwn(part, 'value')
            || !SELECTOR_KEYS.includes(part.key)
            || typeof part.value !== 'string' || part.value.length === 0) {
            validation('path selectors must contain a valid identity key and string value')
        }
    }
}

function validateSnapshot(value, label) {
    if (!isPlainObject(value) || typeof value.exists !== 'boolean') validation(`${label} must contain an exists boolean`)
    const keys = Object.keys(value)
    if (value.exists) {
        if (keys.length !== 2 || !hasOwn(value, 'value')) validation(`${label} with exists true must contain only value`)
    } else if (keys.length !== 1 || hasOwn(value, 'value')) {
        validation(`${label} with exists false must not contain value`)
    }
}

function validatePlacement(change) {
    if (!hasOwn(change, 'placement')) return
    const placement = change.placement
    if (!isPlainObject(placement) || Object.keys(placement).some(key => key !== 'after' && key !== 'before')) {
        validation('placement must contain only after and before IDs')
    }
    for (const key of ['after', 'before']) {
        if (hasOwn(placement, key)
            && (typeof placement[key] !== 'string' || placement[key].length === 0)) {
            validation(`placement.${key} must be a nonempty string`)
        }
    }
    const target = change.path.at(-1)
    if (!target || typeof target === 'string') validation('placement requires an array item selector')
    if ((placement.after !== undefined && placement.after === target.value)
        || (placement.before !== undefined && placement.before === target.value)) {
        validation('placement cannot refer to the item being added')
    }
}

function validateChange(change) {
    if (!isPlainObject(change) || !['value', 'order'].includes(change.kind)) validation('change kind is invalid')
    validatePath(change.path)
    if (change.kind === 'value') {
        const allowed = new Set(['kind', 'path', 'before', 'after', 'placement'])
        if (Object.keys(change).some(key => !allowed.has(key))) validation('value change has unknown fields')
        validateSnapshot(change.before, 'before')
        validateSnapshot(change.after, 'after')
        if (change.before.exists === change.after.exists
            && change.before.exists && valuesEqual(change.before.value, change.after.value)) {
            validation('value change must change its target')
        }
        if (hasOwn(change, 'placement')) {
            if (change.before.exists || !change.after.exists) validation('placement is only valid for an added item')
            validatePlacement(change)
        }
        const target = change.path.at(-1)
        if (target && typeof target === 'object' && change.after.exists) {
            if (identityFor(change.after.value, target.key) !== target.value) {
                validation('added or replaced item identity must match its path selector')
            }
        }
        return
    }

    const allowed = new Set(['kind', 'path', 'identity', 'before', 'after'])
    if (Object.keys(change).some(key => !allowed.has(key))) validation('order change has unknown fields')
    if (!SELECTOR_KEYS.includes(change.identity) || change.path.length === 0) validation('order change identity or path is invalid')
    for (const [label, ids] of [['before', change.before], ['after', change.after]]) {
        if (!Array.isArray(ids) || ids.some(id => typeof id !== 'string' || id.length === 0)
            || new Set(ids).size !== ids.length) validation(`order ${label} must be unique nonempty IDs`)
    }
    const afterIds = new Set(change.after)
    if (change.before.length !== change.after.length
        || change.before.some(id => !afterIds.has(id))) validation('order before and after must contain the same IDs')
    if (valuesEqual(change.before, change.after)) validation('order change must change its target')
}

function resolveParent(root, path) {
    let value = root
    for (const part of path.slice(0, -1)) {
        if (typeof part === 'string') {
            if (!isPlainObject(value) || !hasOwn(value, part)) throw new MissingTarget()
            value = value[part]
        } else {
            if (!Array.isArray(value)) throw new MissingTarget()
            const index = findIdentityIndex(value, part.key, part.value)
            if (index < 0) throw new MissingTarget()
            value = value[index]
        }
    }
    return value
}

function indexIdentities(items, identity) {
    const indices = new Map()
    for (let index = 0; index < items.length; index += 1) {
        const itemId = identityFor(items[index], identity)
        if (itemId === undefined) continue
        if (indices.has(itemId)) validation(`array contains duplicate ${identity} values`)
        indices.set(itemId, index)
    }
    return indices
}

function findIdentityIndex(items, identity, id) {
    return indexIdentities(items, identity).get(id) ?? -1
}

function readTarget(root, path) {
    if (path.length === 0) return { exists: root !== undefined, value: root }
    const parent = resolveParent(root, path)
    const target = path.at(-1)
    if (typeof target === 'string') {
        if (!isPlainObject(parent)) throw new MissingTarget()
        return { exists: hasOwn(parent, target), value: parent[target] }
    }
    if (!Array.isArray(parent)) throw new MissingTarget()
    const index = findIdentityIndex(parent, target.key, target.value)
    return index < 0 ? { exists: false } : { exists: true, value: parent[index] }
}

function targetEquals(actual, expected) {
    return actual.exists === expected.exists && (!actual.exists || valuesEqual(actual.value, expected.value))
}

function writeTarget(root, change) {
    const path = change.path
    if (path.length === 0) return change.after.exists ? cloneJson(change.after.value) : undefined
    const parent = resolveParent(root, path)
    const target = path.at(-1)
    if (typeof target === 'string') {
        if (!isPlainObject(parent)) validation('property path parent must be an object')
        if (change.after.exists) {
            Object.defineProperty(parent, target, {
                value: cloneJson(change.after.value), enumerable: true, configurable: true, writable: true,
            })
        } else {
            delete parent[target]
        }
        return root
    }
    if (!Array.isArray(parent)) validation('selector path parent must be an array')
    const index = findIdentityIndex(parent, target.key, target.value)
    if (!change.after.exists) {
        if (index >= 0) parent.splice(index, 1)
        return root
    }
    const item = cloneJson(change.after.value)
    if (index >= 0) {
        parent[index] = item
        return root
    }
    let insertAt = parent.length
    const placement = change.placement
    if (placement?.before !== undefined) {
        const beforeIndex = findIdentityIndex(parent, target.key, placement.before)
        if (beforeIndex >= 0) insertAt = beforeIndex
        else if (placement.after !== undefined) {
            const afterIndex = findIdentityIndex(parent, target.key, placement.after)
            if (afterIndex >= 0) insertAt = afterIndex + 1
        }
    } else if (placement?.after !== undefined) {
        const afterIndex = findIdentityIndex(parent, target.key, placement.after)
        if (afterIndex >= 0) insertAt = afterIndex + 1
    }
    parent.splice(insertAt, 0, item)
    return root
}

function applyOrder(root, change) {
    const array = change.path.length === 0 ? root : readTarget(root, change.path).value
    if (!Array.isArray(array)) throw new MissingTarget()
    const indices = indexIdentities(array, change.identity)
    const present = new Set(change.before.filter(id => indices.has(id)))
    const before = change.before.filter(id => present.has(id))
    const after = change.after.filter(id => present.has(id))
    const current = array.map(item => identityFor(item, change.identity)).filter(id => id !== undefined && present.has(id))
    if (valuesEqual(current, after)) return root
    if (!valuesEqual(current, before)) return { conflict: true, current }

    const orderedItems = new Map()
    for (const id of after) orderedItems.set(id, array[indices.get(id)])
    let nextIndex = 0
    for (let index = 0; index < array.length; index += 1) {
        const id = identityFor(array[index], change.identity)
        if (id !== undefined && present.has(id)) {
            array[index] = orderedItems.get(after[nextIndex])
            nextIndex += 1
        }
    }
    return root
}

// Clearing a long history must stay linear, so a batch is indexed once and compacted once.
function applyArrayEdits(array, changes, conflicts) {
    const identity = changes[0].path.at(-1).key
    const indices = indexIdentities(array, identity)
    const removed = new Set()
    for (const change of changes) {
        const id = change.path.at(-1).value
        const index = indices.get(id)
        const actual = index === undefined || removed.has(id)
            ? { exists: false } : { exists: true, value: array[index] }
        if (targetEquals(actual, change.after)) continue
        if (!targetEquals(actual, change.before)) {
            conflicts.push({ change, current: snapshot(actual.exists, actual.value) })
        } else if (change.after.exists) {
            array[index] = cloneJson(change.after.value)
        } else {
            removed.add(id)
        }
    }
    if (removed.size === 0) return
    let writeIndex = 0
    for (const item of array) {
        if (!removed.has(identityFor(item, identity))) array[writeIndex++] = item
    }
    array.length = writeIndex
}

export function applyDelta(current, changes) {
    if (!Array.isArray(changes)) validation('changes must be an array')
    for (const change of changes) validateChange(change)

    let result = current === undefined ? undefined : cloneJson(current)
    const conflicts = []
    for (let changeIndex = 0; changeIndex < changes.length; changeIndex++) {
        const change = changes[changeIndex]
        try {
            if (change.kind === 'order') {
                const orderResult = applyOrder(result, change)
                if (orderResult?.conflict) conflicts.push({ change, current: orderResult.current })
                else result = orderResult
                continue
            }
            const target = change.path.at(-1)
            if (target && typeof target === 'object' && change.before.exists) {
                const arrayPath = change.path.slice(0, -1)
                let end = changeIndex + 1
                while (end < changes.length) {
                    const next = changes[end]
                    if (next.kind !== 'value' || !next.before.exists || next.path.at(-1)?.key !== target.key
                        || !valuesEqual(next.path.slice(0, -1), arrayPath)) break
                    end++
                }
                if (end > changeIndex + 1) {
                    const array = resolveParent(result, change.path)
                    if (!Array.isArray(array)) throw new MissingTarget()
                    applyArrayEdits(array, changes.slice(changeIndex, end), conflicts)
                    changeIndex = end - 1
                    continue
                }
            }
            const actual = readTarget(result, change.path)
            if (targetEquals(actual, change.after)) continue
            const atomicMessage = typeof target === 'object' && target?.key === 'chatId'
            if (!change.before.exists && actual.exists && change.after.exists && !atomicMessage) {
                const objectCreation = isPlainObject(actual.value) && isPlainObject(change.after.value)
                const listCreation = Array.isArray(actual.value) && Array.isArray(change.after.value)
                    && detectIdentity([], change.after.value, change.path)
                if (objectCreation || listCreation) {
                    const children = diffAt(change.path, objectCreation ? {} : [], change.after.value)
                    try { result = applyDelta(result, children) }
                    catch (error) {
                        if (!(error instanceof DeltaConflictError)) throw error
                        conflicts.push(...error.conflicts)
                    }
                    continue
                }
            }
            if (targetEquals(actual, change.before)) {
                result = writeTarget(result, change)
            } else {
                conflicts.push({ change, current: snapshot(actual.exists, actual.value) })
            }
        } catch (error) {
            if (!(error instanceof MissingTarget)) throw error
            conflicts.push({ change, current: { exists: false } })
        }
    }
    if (conflicts.length > 0) throw new DeltaConflictError(conflicts)
    return result
}
