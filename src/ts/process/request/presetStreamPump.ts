import type { AdapterChatStreamDelta } from "src/ts/preset/adapter"
import { formatAdapterReasoning } from "src/ts/preset/adapter/decodedEvents"

// Adapters yield one delta per token. Snapshots are emitted at most this often
// (the first delta and the tail without delay), since only the newest one is
// rendered.
const SNAPSHOT_INTERVAL_MS = 50

interface PresetSnapshotStreamHooks {
    /** Logging side channel; the stream errors either way. */
    onError?: (err: unknown) => void
    /** Sees every raw delta, for request status. */
    onDelta?: (delta: AdapterChatStreamDelta) => void
    /** Fires once at the end with the newest usage any delta carried. */
    onFinish?: (outcome: 'done' | 'failed', lastUsage?: AdapterChatStreamDelta['usage']) => void
}

export interface RetryingSnapshotStreamOptions<T> {
    createAttempt: () => ReadableStream<T>
    /** Identifies the first chunk that contains provider response content. */
    startsResponse?: (chunk: T) => boolean
    /** Return the delay before the next attempt, or null to surface the error. */
    retryDelayMs: (error: unknown) => number | null
    onRetry?: (error: unknown) => void
    onFinalError?: (error: unknown) => void
}

/**
 * Relays full-snapshot streams and retries only before response content starts.
 * Once a meaningful response chunk has reached the consumer, a later failure
 * is surfaced as-is so a partially generated answer is never replayed.
 */
export function createRetryingSnapshotStream<T>(
    options: RetryingSnapshotStreamOptions<T>,
): ReadableStream<T> {
    let cancelled = false
    let responseStarted = false
    let activeReader: ReadableStreamDefaultReader<T> | undefined

    return new ReadableStream<T>({
        async start(controller) {
            while (!cancelled) {
                try {
                    activeReader = options.createAttempt().getReader()
                    while (!cancelled) {
                        const next = await activeReader.read()
                        if (next.done) {
                            controller.close()
                            return
                        }
                        if (options.startsResponse?.(next.value) ?? true) {
                            responseStarted = true
                        }
                        controller.enqueue(next.value)
                    }
                } catch (error) {
                    if (cancelled) return
                    const delayMs = responseStarted ? null : options.retryDelayMs(error)
                    if (delayMs === null) {
                        options.onFinalError?.(error)
                        controller.error(error)
                        return
                    }
                    options.onRetry?.(error)
                    if (delayMs > 0) {
                        await new Promise(resolve => setTimeout(resolve, delayMs))
                    }
                } finally {
                    activeReader?.releaseLock()
                    activeReader = undefined
                }
            }
        },
        cancel(reason) {
            cancelled = true
            return activeReader?.cancel(reason)
        },
    })
}

/** Streams an adapter's deltas as accumulated-text snapshots. */
export function presetSnapshotStream(
    gen: AsyncGenerator<AdapterChatStreamDelta, void, void>,
    { onError, onDelta, onFinish }: PresetSnapshotStreamHooks = {},
): ReadableStream<Record<string, string>> {
    return new ReadableStream({
        async start(controller) {
            let lastUsage: AdapterChatStreamDelta['usage'] | undefined
            let fullText = ''
            let reasoningText = ''
            let lastFlushAt = -Infinity
            let trailing: ReturnType<typeof setTimeout> | undefined
            const flush = () => {
                clearTimeout(trailing)
                trailing = undefined
                lastFlushAt = Date.now()
                // Reasoning is prefixed, as in the non-streaming path, so it is
                // never merged into the saved answer.
                const reasoning = reasoningText ? formatAdapterReasoning([{ text: reasoningText }]) : ''
                controller.enqueue({ '0': reasoning + fullText })
            }
            try {
                for await (const delta of gen) {
                    onDelta?.(delta)
                    if (delta.usage) lastUsage = delta.usage
                    if (delta.reasoningDelta) reasoningText += delta.reasoningDelta
                    fullText += delta.textDelta
                    const wait = lastFlushAt + SNAPSHOT_INTERVAL_MS - Date.now()
                    if (wait <= 0) flush()
                    else trailing ??= setTimeout(flush, wait)
                }
                if (trailing !== undefined) flush()
                controller.close()
                onFinish?.('done', lastUsage)
            } catch (err) {
                clearTimeout(trailing)
                onError?.(err)
                controller.error(err)
                onFinish?.('failed', lastUsage)
            }
        },
    })
}

// Delivers only the newest full-text snapshot, and before each delivery after
// the first yields the main thread for as long as the consumer spent on the
// previous one (at least one short timer, longer while timers fire late because
// a render is still running). Streamed responses arrive as one network task per
// token; without that idle time every task is followed by a full re-render and
// the display falls behind a server that has already finished.
const MIN_YIELD_MS = 4
const MAX_YIELD_MS = 1000
const LATE_TIMER_MS = 16

type SourceEnd = { failed: false } | { failed: true, error: unknown }

export function paceSnapshotStream<T>(source: ReadableStream<T>): ReadableStream<T> {
    const reader = source.getReader()
    let latest: { value: T } | undefined
    let ended: SourceEnd | undefined
    let onChunk: (() => void) | undefined
    let onEnd: (() => void) | undefined
    let deliveredAt: number | undefined

    void (async () => {
        try {
            while (true) {
                const next = await reader.read()
                if (next.done) break
                latest = { value: next.value }
                onChunk?.()
            }
            ended = { failed: false }
        } catch (error) {
            ended = { failed: true, error }
        }
        onChunk?.()
        onEnd?.()
    })()

    // Resolves after `ms`, or as soon as the source ends.
    const sleep = (ms: number) => new Promise<void>((resolve) => {
        const finish = () => {
            clearTimeout(timer)
            onEnd = undefined
            resolve()
        }
        const timer = setTimeout(finish, ms)
        onEnd = finish
    })

    const yieldMainThread = async (consumerBusyMs: number) => {
        const deadline = Date.now() + MAX_YIELD_MS
        let wait = Math.min(Math.max(consumerBusyMs, MIN_YIELD_MS), MAX_YIELD_MS)
        while (wait > 0 && !ended) {
            const due = Date.now() + wait
            await sleep(wait)
            const late = Date.now() - due
            wait = late > LATE_TIMER_MS ? Math.min(late, deadline - Date.now()) : 0
        }
    }

    return new ReadableStream<T>({
        async pull(controller) {
            if (deliveredAt !== undefined) await yieldMainThread(Date.now() - deliveredAt)
            while (!latest && !ended) {
                await new Promise<void>((resolve) => { onChunk = resolve })
            }
            onChunk = undefined
            if (latest) {
                controller.enqueue(latest.value)
                latest = undefined
                deliveredAt = Date.now()
            }
            else if (ended?.failed) controller.error(ended.error)
            else controller.close()
        },
        cancel(reason) {
            return reader.cancel(reason)
        },
    }, { highWaterMark: 0 })
}
