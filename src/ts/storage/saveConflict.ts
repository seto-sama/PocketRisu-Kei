import { writable } from 'svelte/store'
import { language } from 'src/lang'
import { applyDelta } from '../../../shared/guardedDelta.mjs'
import { mergeWithConflictChoices, type ConflictChoice, type MergeConflict } from './patchRebase'
import type { DeltaPatch } from './nodeStorage'

export type SaveConflictDialogState = {
    title: string
    items: MergeConflict[]
    source?: unknown
    complete: (choices: ConflictChoice[] | null) => void
}

export const saveConflictDialog = writable<SaveConflictDialogState | null>(null)
let dialogQueue = Promise.resolve()

export class SaveConflictCancelledError extends Error {
    constructor() {
        super('Save conflict resolution cancelled')
        this.name = 'SaveConflictCancelledError'
    }
}

/** The same merge supplies the preview and the chosen result. */
export function prepareSaveConflict<T>(base: T | undefined, changes: DeltaPatch['changes'], server: T) {
    const local = applyDelta(base, changes) as T
    const items: MergeConflict[] = []
    const merged = mergeWithConflictChoices(base, local, server, conflict => {
        items.push(conflict)
        return 'local'
    })
    return {
        items,
        merged,
        resolve(choices: ConflictChoice[]) {
            let index = 0
            return mergeWithConflictChoices(base, local, server, () => choices[index++] ?? 'server')
        },
    }
}

export async function chooseSaveConflict<T>(base: T | undefined, changes: DeltaPatch['changes'], server: T, title = ''): Promise<T> {
    const plan = prepareSaveConflict(base, changes, server)
    if (plan.items.length === 0) return plan.merged
    const previous = dialogQueue
    let release!: () => void
    dialogQueue = new Promise<void>(resolve => { release = resolve })
    await previous
    try {
        const choices = await new Promise<ConflictChoice[] | null>(resolve => {
            saveConflictDialog.set({
                title: title || language.saveConflict.title,
                items: plan.items,
                source: plan.merged,
                complete: resolve,
            })
        })
        if (!choices) throw new SaveConflictCancelledError()
        return plan.resolve(choices)
    } finally {
        saveConflictDialog.set(null)
        release()
    }
}
