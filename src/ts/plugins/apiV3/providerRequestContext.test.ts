import { describe, expect, it, vi } from 'vitest'
import { resolveProviderRequestContext, withProviderRequestContext } from './providerRequestContext'

describe('provider request context lifetime', () => {
    it('keeps streaming follow-up fetches attributable until completion', async () => {
        const contexts = new Map<string, string>()
        const abort = new AbortController()
        let source!: ReadableStreamDefaultController<string>
        const response = await withProviderRequestContext(contexts, 'a', 'chat-a', abort.signal, async () => ({
            success: true,
            content: new ReadableStream<string>({ start(controller) { source = controller } }),
        }))
        expect(resolveProviderRequestContext(contexts, 'a')).toBe('chat-a')
        expect(resolveProviderRequestContext(contexts)).toBe('chat-a')
        const reader = (response.content as ReadableStream<string>).getReader()
        source.enqueue('first')
        expect(await reader.read()).toEqual({ done: false, value: 'first' })
        expect(resolveProviderRequestContext(contexts, 'a')).toBe('chat-a')
        source.enqueue('follow-up')
        source.close()
        expect(await reader.read()).toEqual({ done: false, value: 'follow-up' })
        expect((await reader.read()).done).toBe(true)
        await vi.waitFor(() => expect(contexts.size).toBe(0))
    })

    it('does not attribute concurrent or stale requests to another invocation', async () => {
        const contexts = new Map<string, string>()
        const start = (token: string) => withProviderRequestContext(contexts, token, token, new AbortController().signal,
            async () => ({ success: true, content: new ReadableStream<string>() }))
        const first = await start('a')
        const second = await start('b')
        expect(resolveProviderRequestContext(contexts)).toBeUndefined()
        expect(resolveProviderRequestContext(contexts, 'a')).toBe('a')
        expect(resolveProviderRequestContext(contexts, 'b')).toBe('b')
        await (first.content as ReadableStream<string>).cancel()
        await vi.waitFor(() => expect(contexts.size).toBe(1))
        expect(resolveProviderRequestContext(contexts, 'a')).toBeUndefined()
        expect(resolveProviderRequestContext(contexts)).toBe('b')
        await (second.content as ReadableStream<string>).cancel()
        await vi.waitFor(() => expect(contexts.size).toBe(0))
    })

    it.each(['cancel', 'abort', 'error'] as const)('cleans up on %s and propagates termination', async (action) => {
        const contexts = new Map<string, string>()
        const abort = new AbortController()
        const removeListener = vi.spyOn(abort.signal, 'removeEventListener')
        const cancel = vi.fn()
        let source!: ReadableStreamDefaultController<string>
        const stream = new ReadableStream<string>({ start(controller) { source = controller }, cancel })
        const response = await withProviderRequestContext(contexts, 'a', 'chat-a', abort.signal, async () => ({
            success: true,
            content: stream,
        }))
        const reader = (response.content as ReadableStream<string>).getReader()
        const reason = new Error('stopped')
        if (action === 'cancel') {
            await reader.cancel(reason)
        } else {
            const read = expect(reader.read()).rejects.toBe(reason)
            if (action === 'abort') abort.abort(reason)
            else source.error(reason)
            await read
        }
        await vi.waitFor(() => expect(contexts.size).toBe(0))
        await vi.waitFor(() => expect(stream.locked).toBe(false))
        expect(removeListener).toHaveBeenCalledWith('abort', expect.any(Function))
        if (action !== 'error') expect(cancel).toHaveBeenCalledWith(reason)
    })

    it('applies backpressure instead of buffering an unread provider response', async () => {
        const contexts = new Map<string, string>()
        const pull = vi.fn((controller: ReadableStreamDefaultController<string>) => controller.enqueue('chunk'))
        const response = await withProviderRequestContext(contexts, 'a', 'chat-a', new AbortController().signal, async () => ({
            success: true,
            content: new ReadableStream<string>({ pull }, { highWaterMark: 0 }),
        }))
        await vi.waitFor(() => expect(pull).toHaveBeenCalled())
        expect(pull).toHaveBeenCalledTimes(1)
        await (response.content as ReadableStream<string>).cancel()
        await vi.waitFor(() => expect(contexts.size).toBe(0))
    })

    it('removes context when aborted while awaiting the provider callback', async () => {
        const contexts = new Map<string, string>()
        const abort = new AbortController()
        const cancel = vi.fn()
        let resolve!: (value: { success: boolean; content: ReadableStream<string> }) => void
        const pending = withProviderRequestContext(contexts, 'a', 'chat-a', abort.signal,
            () => new Promise(done => { resolve = done }))
        expect(contexts.size).toBe(1)
        abort.abort()
        expect(contexts.size).toBe(0)
        resolve({ success: true, content: new ReadableStream<string>({ cancel }) })
        const response = await pending
        await expect((response.content as ReadableStream<string>).getReader().read()).rejects.toMatchObject({ name: 'AbortError' })
        expect(cancel).toHaveBeenCalled()
        expect(contexts.size).toBe(0)
    })

    it('cleans up plain responses and thrown errors', async () => {
        const contexts = new Map<string, string>()
        const invoke = (callback: () => Promise<{ success: boolean; content: string }>) =>
            withProviderRequestContext(contexts, 'a', 'chat-a', new AbortController().signal, callback)
        expect(await invoke(async () => ({ success: true, content: 'answer' }))).toEqual({ success: true, content: 'answer' })
        expect(contexts.size).toBe(0)
        await expect(invoke(async () => { throw new Error('failed') })).rejects.toThrow('failed')
        expect(contexts.size).toBe(0)
    })

    it('does not invoke an already aborted request', async () => {
        const contexts = new Map<string, string>()
        const abort = new AbortController()
        abort.abort()
        const invoke = vi.fn()
        await expect(withProviderRequestContext(contexts, 'a', 'chat-a', abort.signal, invoke)).rejects.toThrow()
        expect(invoke).not.toHaveBeenCalled()
        expect(contexts.size).toBe(0)
    })
})
