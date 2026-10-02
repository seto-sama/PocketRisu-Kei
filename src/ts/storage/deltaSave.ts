import { isRetryableSaveError } from './storageRequest'
import type { DeltaPatch } from './nodeStorage'

/** Settle an uncertain write before advancing its baseline or sending newer edits. */
export class DeltaSave<Snapshot, Result> {
    private pending: { request: DeltaPatch, snapshot: Snapshot } | null = null

    constructor(
        private send: (request: DeltaPatch) => Promise<Result>,
        private acknowledge: (snapshot: Snapshot, result: Result) => void | Promise<void>,
    ) {}

    clear() { this.pending = null }

    get hasPending() { return this.pending !== null }

    async flush(): Promise<Result | undefined> {
        const pending = this.pending
        if (!pending) return
        try {
            const result = await this.send(pending.request)
            if (this.pending !== pending) return result
            await this.acknowledge(pending.snapshot, result)
            if (this.pending === pending) this.pending = null
            return result
        } catch (error) {
            if (!isRetryableSaveError(error) && this.pending === pending) this.pending = null
            throw error
        }
    }

    async save(request: DeltaPatch, snapshot: Snapshot): Promise<Result | undefined> {
        if (this.pending) throw new Error('Pending delta must be settled before creating a new save')
        this.pending = { request, snapshot }
        return this.flush()
    }
}
