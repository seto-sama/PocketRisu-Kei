import { writable } from 'svelte/store'
import { language } from 'src/lang'
import { applyDelta } from '../../../shared/guardedDelta.mjs'
import { mergeWithConflictChoices, type ConflictChoice, type MergeConflict } from './patchRebase'
import type { DeltaPatch } from './nodeStorage'
import { presentSaveConflict, type ConflictPresentation } from '../gui/saveConflictPresentation'

export type ConflictSelection = 'server' | 'local' | 'both' | null

export type ConflictComparisonRequest = {
    title: string
    items: ConflictPresentation[]
    multiple?: boolean
    description?: string
    serverLabel?: string
    localLabel?: string
    submitLabel?: string
}

export type SaveConflictDialogState = ConflictComparisonRequest & {
    complete: (choices: ConflictSelection[] | null) => void
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

export async function chooseConflictComparison(
    request: ConflictComparisonRequest,
    signal?: AbortSignal,
): Promise<ConflictSelection[]> {
    if (signal?.aborted) throw new SaveConflictCancelledError()

    const previous = dialogQueue
    let release!: () => void
    dialogQueue = new Promise<void>(resolve => { release = resolve })
    await previous
    try {
        if (signal?.aborted) throw new SaveConflictCancelledError()
        const choices = await new Promise<ConflictSelection[] | null>(resolve => {
            let settled = false
            const complete: SaveConflictDialogState['complete'] = selection => {
                if (settled) return
                settled = true
                signal?.removeEventListener('abort', onAbort)
                saveConflictDialog.update(current => current?.complete === complete ? null : current)
                resolve(selection)
            }
            const onAbort = () => complete(null)
            signal?.addEventListener('abort', onAbort, { once: true })
            saveConflictDialog.set({ ...request, complete })
            if (signal?.aborted) onAbort()
        })
        if (choices === null) throw new SaveConflictCancelledError()
        return choices
    } finally {
        release()
    }
}

export async function chooseSaveConflict<T>(base: T | undefined, changes: DeltaPatch['changes'], server: T, title = ''): Promise<T> {
    const plan = prepareSaveConflict(base, changes, server)
    if (plan.items.length === 0) return plan.merged
    const choices = await chooseConflictComparison({
        title: title || language.saveConflict.title,
        items: plan.items.map((item, index) => presentSaveConflict(item, index, plan.merged)),
    })
    const exclusiveChoices = choices.map(choice => {
        if (choice === 'server' || choice === 'local') return choice
        throw new Error('Exclusive save conflict choices must select one side')
    })
    return plan.resolve(exclusiveChoices)
}
