import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import {
    createRetryingSnapshotStream,
    paceSnapshotStream,
    presetSnapshotStream,
} from './presetStreamPump'
import type { AdapterChatStreamDelta } from 'src/ts/preset/adapter'

async function* genOf(
    ...deltas: Array<Partial<AdapterChatStreamDelta>>
): AsyncGenerator<AdapterChatStreamDelta, void, void> {
    for (const d of deltas) yield { textDelta: '', ...d }
}

/** Reads snapshots in the background so timer-driven flushes can be observed. */
function collect(stream: ReadableStream<Record<string, string>>) {
    const snapshots: string[] = []
    const done = (async () => {
        for await (const chunk of stream) snapshots.push(chunk['0'])
    })()
    return { snapshots, done }
}

describe('presetSnapshotStream', () => {
    beforeEach(() => { vi.useFakeTimers() })
    afterEach(() => { vi.useRealTimers() })

    test('emits the first delta at once and the coalesced tail at the end', async () => {
        const { snapshots, done } = collect(presetSnapshotStream(
            genOf({ textDelta: 'a' }, { textDelta: 'b' }, { textDelta: 'c' }),
        ))
        await done
        expect(snapshots).toEqual(['a', 'abc'])
        expect(vi.getTimerCount()).toBe(0)
    })

    test('prefixes accumulated reasoning as a Thoughts block', async () => {
        const { snapshots, done } = collect(presetSnapshotStream(
            genOf({ reasoningDelta: 'why' }, { textDelta: 'answer' }),
        ))
        await done
        expect(snapshots.at(-1)).toBe('<Thoughts>\nwhy\n</Thoughts>\n\nanswer')
    })

    test('flushes the tail when the provider pauses mid-response', async () => {
        let release!: () => void
        const gate = new Promise<void>((r) => { release = r })
        async function* paused(): AsyncGenerator<AdapterChatStreamDelta, void, void> {
            yield { textDelta: 'a' }
            yield { textDelta: 'b' }
            await gate
            yield { textDelta: 'c' }
        }
        const { snapshots, done } = collect(presetSnapshotStream(paused()))

        await vi.advanceTimersByTimeAsync(1)
        expect(snapshots).toEqual(['a'])
        await vi.advanceTimersByTimeAsync(60)
        expect(snapshots).toEqual(['a', 'ab'])
        release()
        await done
        expect(snapshots).toEqual(['a', 'ab', 'abc'])
    })

    test('reports every delta and the last usage when the stream completes', async () => {
        const onDelta = vi.fn()
        const onFinish = vi.fn()
        const { done } = collect(presetSnapshotStream(
            genOf({ reasoningDelta: 'why' }, { textDelta: 'a' }, { textDelta: 'b', usage: { completionTokens: 7 } }),
            { onDelta, onFinish },
        ))
        await done
        expect(onDelta).toHaveBeenCalledTimes(3)
        expect(onFinish).toHaveBeenCalledExactlyOnceWith('done', { completionTokens: 7 })
    })

    test('errors the stream and reports a provider failure', async () => {
        const onError = vi.fn()
        const onFinish = vi.fn()
        const boom = new Error('aborted mid-stream')
        async function* exploding(): AsyncGenerator<AdapterChatStreamDelta, void, void> {
            yield { textDelta: 'a' }
            yield { textDelta: 'b' }
            throw boom
        }
        const { done } = collect(presetSnapshotStream(exploding(), { onError, onFinish }))

        await expect(done).rejects.toBe(boom)
        expect(onError).toHaveBeenCalledWith(boom)
        expect(onFinish).toHaveBeenCalledExactlyOnceWith('failed', undefined)
        expect(vi.getTimerCount()).toBe(0)
    })
})

describe('createRetryingSnapshotStream', () => {
    function attempt(values: string[], error?: Error): ReadableStream<string> {
        return new ReadableStream({
            async start(controller) {
                for (const value of values) {
                    controller.enqueue(value)
                    await Promise.resolve()
                }
                if (error) controller.error(error)
                else controller.close()
            },
        })
    }

    test('starts a fresh stream when a retryable error occurs before response content', async () => {
        const overload = new Error('overloaded')
        const attempts = [attempt([''], overload), attempt(['fresh', 'complete'])]
        const onRetry = vi.fn()
        const stream = createRetryingSnapshotStream({
            createAttempt: () => attempts.shift()!,
            startsResponse: value => value.length > 0,
            retryDelayMs: () => 0,
            onRetry,
        })

        const received: string[] = []
        for await (const value of stream) received.push(value)

        expect(received).toEqual(['', 'fresh', 'complete'])
        expect(onRetry).toHaveBeenCalledOnce()
    })

    test('does not retry after response content has started', async () => {
        const disconnected = new Error('disconnected')
        const createAttempt = vi.fn(() => attempt(['partial'], disconnected))
        const onRetry = vi.fn()
        const onFinalError = vi.fn()
        const stream = createRetryingSnapshotStream({
            createAttempt,
            startsResponse: value => value.length > 0,
            retryDelayMs: () => 0,
            onRetry,
            onFinalError,
        })

        const reader = stream.getReader()
        expect(await reader.read()).toEqual({ value: 'partial', done: false })
        await expect(reader.read()).rejects.toBe(disconnected)
        expect(createAttempt).toHaveBeenCalledOnce()
        expect(onRetry).not.toHaveBeenCalled()
        expect(onFinalError).toHaveBeenCalledWith(disconnected)
    })

    test('surfaces the final error when the retry budget is exhausted', async () => {
        const overload = new Error('overloaded')
        const onFinalError = vi.fn()
        const stream = createRetryingSnapshotStream({
            createAttempt: () => attempt([], overload),
            retryDelayMs: () => null,
            onFinalError,
        })

        const reader = stream.getReader()
        await expect(reader.read()).rejects.toBe(overload)
        expect(onFinalError).toHaveBeenCalledWith(overload)
    })
})

function controllableSource() {
    let controller!: ReadableStreamDefaultController<string>
    const stream = new ReadableStream<string>({ start(c) { controller = c } })
    return { stream, controller }
}

describe('paceSnapshotStream', () => {
    beforeEach(() => { vi.useFakeTimers() })
    afterEach(() => { vi.useRealTimers() })

    test('delivers only the newest snapshot available at read time', async () => {
        const source = controllableSource()
        const reader = paceSnapshotStream(source.stream).getReader()
        source.controller.enqueue('a')
        source.controller.enqueue('ab')
        source.controller.enqueue('abc')
        await vi.advanceTimersByTimeAsync(0)

        expect(await reader.read()).toEqual({ value: 'abc', done: false })
        source.controller.close()
        expect(await reader.read()).toEqual({ value: undefined, done: true })
    })

    test('yields for as long as the consumer spent on the previous snapshot', async () => {
        const source = controllableSource()
        const reader = paceSnapshotStream(source.stream).getReader()
        source.controller.enqueue('a')
        expect((await reader.read()).value).toBe('a')

        // The consumer renders 'a' for 100ms, then asks for more.
        await vi.advanceTimersByTimeAsync(100)
        source.controller.enqueue('ab')
        let next: string | undefined
        void reader.read().then(result => { next = result.value })

        await vi.advanceTimersByTimeAsync(90)
        source.controller.enqueue('abc')
        expect(next).toBeUndefined()
        await vi.advanceTimersByTimeAsync(10)
        expect(next).toBe('abc')
    })

    test('ends the yield as soon as the source completes', async () => {
        const source = controllableSource()
        const reader = paceSnapshotStream(source.stream).getReader()
        source.controller.enqueue('a')
        await reader.read()
        await vi.advanceTimersByTimeAsync(500)

        const pending = reader.read()
        source.controller.enqueue('ab')
        source.controller.close()
        await vi.advanceTimersByTimeAsync(0)
        expect(await pending).toEqual({ value: 'ab', done: false })
        expect((await reader.read()).done).toBe(true)
    })

    test('delivers the newest snapshot before surfacing a source error', async () => {
        const source = controllableSource()
        const reader = paceSnapshotStream(source.stream).getReader()
        const failure = new Error('disconnected')
        source.controller.enqueue('partial')
        source.controller.error(failure)
        await vi.advanceTimersByTimeAsync(0)

        expect((await reader.read()).value).toBe('partial')
        await expect(reader.read()).rejects.toBe(failure)
    })

    test('keeps yielding while a render delays its timers', async () => {
        const source = controllableSource()
        const reader = paceSnapshotStream(source.stream).getReader()
        source.controller.enqueue('a')
        await reader.read()

        // A synchronous consumer returns at once; its render then blocks the
        // main thread for 100ms before the pacer's first timer can fire.
        setTimeout(() => vi.setSystemTime(Date.now() + 100), 0)
        let next: string | undefined
        void reader.read().then(result => { next = result.value })
        source.controller.enqueue('ab')

        await vi.advanceTimersByTimeAsync(50)
        expect(next).toBeUndefined()
        await vi.advanceTimersByTimeAsync(100)
        expect(next).toBe('ab')
    })
})
