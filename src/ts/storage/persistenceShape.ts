/** Character fields that exist only to drive the current browser runtime. */
const runtimeOnlyCharacterFields = new Set(['reloadKeys'])
const serverOwnedCharacterFields = new Set(['lastInteraction'])

export function isRuntimeOnlyCharacterField(key: string): boolean {
    return runtimeOnlyCharacterFields.has(key)
}

/** Whether a character field belongs to browser-authored persistence. */
export function isClientWritableCharacterField(key: string): boolean {
    return !runtimeOnlyCharacterFields.has(key) && !serverOwnedCharacterFields.has(key)
}

/** Remove browser-local runtime state before hashing or serializing a character. */
export function characterToPersistentShape<T extends Record<string, any>>(character: T): Omit<T, 'reloadKeys'> {
    const persistent = { ...character }
    for (const key of runtimeOnlyCharacterFields) delete persistent[key]
    return persistent
}

/** Fields a browser may send when replacing a character block. */
export function characterToClientWriteShape<T extends Record<string, any>>(character: T) {
    const writable = characterToPersistentShape(character) as Record<string, any>
    for (const key of serverOwnedCharacterFields) delete writable[key]
    return writable
}

/** Root fields a browser may send in a full database write. */
export function rootValueToClientWriteShape(key: string, value: any) {
    if (key !== 'statics' || !value || typeof value !== 'object') return value
    const writable = { ...value }
    delete writable.messages
    return writable
}

/** Read only browser-owned root values inside a reactive dependency tracker. */
export function visitClientWritableRootValues(
    key: string,
    value: any,
    visit: (value: any) => void,
) {
    if (key !== 'statics' || !value || typeof value !== 'object') {
        visit(value)
        return
    }
    for (const staticsKey of Object.keys(value)) {
        if (staticsKey !== 'messages') visit(value[staticsKey])
    }
}

/** Keep server-owned values fixed to the patch baseline while diffing. */
export function rootValueWithServerBaseline(key: string, value: any, baseline: any) {
    if (key !== 'statics') return value
    const next = value && typeof value === 'object' ? { ...value } : {}
    if (baseline && Object.prototype.hasOwnProperty.call(baseline, 'messages')) {
        next.messages = baseline.messages
    } else {
        delete next.messages
    }
    return next
}

export function characterWithServerBaseline(character: any, baseline: any) {
    const next = characterToPersistentShape(character) as Record<string, any>
    for (const key of serverOwnedCharacterFields) {
        if (baseline && Object.prototype.hasOwnProperty.call(baseline, key)) {
            next[key] = baseline[key]
        } else {
            delete next[key]
        }
    }
    return next
}

/** Restore browser-local defaults after a persisted database is loaded. */
export function initializeCharacterRuntimeState<T>(character: T & { reloadKeys?: number }): T & { reloadKeys?: number } {
    if (!Number.isFinite(character.reloadKeys)) character.reloadKeys = 0
    return character
}
