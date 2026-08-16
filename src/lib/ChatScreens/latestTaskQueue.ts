export interface LatestTaskQueue<TRequest, TResult> {
    enqueue(request: TRequest): Promise<TResult>
    clearPending(): void
    destroy(): void
}

type Waiter<TResult> = {
    resolve: (value: TResult) => void
    reject: (reason: unknown) => void
}

type QueuedTask<TRequest, TResult> = {
    request: TRequest
    waiters: Waiter<TResult>[]
}

/**
 * Run at most one task at a time and retain only the newest pending request.
 * Callers whose pending request was superseded resolve with that newest result,
 * so reactive consumers can await their own promise without rendering stale
 * intermediate snapshots.
 */
export function createLatestTaskQueue<TRequest, TResult>(
    run: (request: TRequest) => Promise<TResult>,
): LatestTaskQueue<TRequest, TResult> {
    let running = false
    let destroyed = false
    let pending: QueuedTask<TRequest, TResult> | null = null

    const start = async (task: QueuedTask<TRequest, TResult>) => {
        running = true
        try {
            const result = await run(task.request)
            task.waiters.forEach(waiter => waiter.resolve(result))
        }
        catch (error) {
            task.waiters.forEach(waiter => waiter.reject(error))
        }
        finally {
            running = false
            if (!destroyed && pending) {
                const next = pending
                pending = null
                void start(next)
            }
        }
    }

    return {
        enqueue(request) {
            return new Promise<TResult>((resolve, reject) => {
                if (destroyed) {
                    reject(new Error('Latest task queue has been destroyed'))
                    return
                }

                const waiter = { resolve, reject }
                if (!running) {
                    void start({ request, waiters: [waiter] })
                    return
                }

                if (pending) {
                    pending.request = request
                    pending.waiters.push(waiter)
                }
                else {
                    pending = { request, waiters: [waiter] }
                }
            })
        },
        clearPending() {
            pending = null
        },
        destroy() {
            if (destroyed) return
            destroyed = true
            pending = null
        },
    }
}
