import type { RevenantWorkflowStatus } from './types'

export interface RevenantWorkflowUpdateEvent {
    workflowId: string
    characterId: string
    roomId: string
    status: RevenantWorkflowStatus
}

const listeners = new Set<(event: RevenantWorkflowUpdateEvent) => void>()
const syncReadyListeners = new Set<() => void>()

export function emitRevenantWorkflowUpdate(event: RevenantWorkflowUpdateEvent): void {
    for (const listener of listeners) listener(event)
}

export function subscribeRevenantWorkflowUpdates(
    listener: (event: RevenantWorkflowUpdateEvent) => void,
): () => void {
    listeners.add(listener)
    return () => listeners.delete(listener)
}

export function emitRevenantWorkflowSyncReady(): void {
    for (const listener of syncReadyListeners) listener()
}

export function subscribeRevenantWorkflowSyncReady(listener: () => void): () => void {
    syncReadyListeners.add(listener)
    return () => syncReadyListeners.delete(listener)
}

export function createRevenantWorkflowUpdateWaiter(
    workflowId: string,
    signal?: AbortSignal,
    fallbackMs = 30_000,
): { promise: Promise<void>, cancel: () => void } {
    let finish = () => {}
    const promise = new Promise<void>(resolve => {
        let settled = false
        const unsubscribeUpdate = subscribeRevenantWorkflowUpdates(event => {
            if (event.workflowId === workflowId) finish()
        })
        const unsubscribeSyncReady = subscribeRevenantWorkflowSyncReady(() => finish())
        const timer = setTimeout(() => finish(), fallbackMs)
        const onAbort = () => finish()
        signal?.addEventListener('abort', onAbort, { once: true })
        finish = () => {
            if (settled) return
            settled = true
            clearTimeout(timer)
            unsubscribeUpdate()
            unsubscribeSyncReady()
            signal?.removeEventListener('abort', onAbort)
            resolve()
        }
    })
    return { promise, cancel: () => finish() }
}
