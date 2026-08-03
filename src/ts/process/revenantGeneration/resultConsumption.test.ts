import { describe, expect, it, vi } from 'vitest'
import { consumeOnStreamCompletion } from './resultConsumption'

async function readAll<T>(stream: ReadableStream<T>): Promise<T[]> {
    const reader = stream.getReader()
    const values:T[] = []
    while (true) {
        const item = await reader.read()
        if (item.done) return values
        values.push(item.value)
    }
}

describe('auxiliary result consumption', () => {
    it('acknowledges a streaming result exactly once after EOF', async () => {
        const consume = vi.fn().mockResolvedValue(undefined)
        const stream = consumeOnStreamCompletion(new ReadableStream<string>({
            start(controller) {
                controller.enqueue('one')
                controller.enqueue('two')
                controller.close()
            },
        }), consume)

        await expect(readAll(stream)).resolves.toEqual(['one', 'two'])
        expect(consume).toHaveBeenCalledTimes(1)
    })

    it('does not acknowledge output cancelled before EOF', async () => {
        const consume = vi.fn().mockResolvedValue(undefined)
        const stream = consumeOnStreamCompletion(new ReadableStream<string>({
            pull(controller) {
                controller.enqueue('partial')
            },
        }), consume)
        const reader = stream.getReader()

        await reader.read()
        await reader.cancel()

        expect(consume).not.toHaveBeenCalled()
    })

    it('does not acknowledge a source that fails while being decoded', async () => {
        const consume = vi.fn().mockResolvedValue(undefined)
        const stream = consumeOnStreamCompletion(new ReadableStream<string>({
            start(controller) {
                controller.error(new Error('broken stream'))
            },
        }), consume)

        await expect(readAll(stream)).rejects.toThrow('broken stream')
        expect(consume).not.toHaveBeenCalled()
    })
})
