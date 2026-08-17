import { describe, expect, it } from 'vitest'
import { createLatestTaskQueue } from './latestTaskQueue'

function deferred<T>() {
    let resolve!: (value: T) => void
    let reject!: (reason: unknown) => void
    const promise = new Promise<T>((res, rej) => {
        resolve = res
        reject = rej
    })
    return { promise, resolve, reject }
}

describe('latest task queue', () => {
    it('runs one task at a time and skips superseded pending requests', async () => {
        const running = deferred<string>()
        const latest = deferred<string>()
        const started: string[] = []
        const queue = createLatestTaskQueue<string, string>((request) => {
            started.push(request)
            return request === 'first' ? running.promise : latest.promise
        })

        const firstResult = queue.enqueue('first')
        const skippedResult = queue.enqueue('second')
        const latestResult = queue.enqueue('third')

        expect(started).toEqual(['first'])
        running.resolve('first result')
        await expect(firstResult).resolves.toBe('first result')
        expect(started).toEqual(['first', 'third'])

        latest.resolve('latest result')
        await expect(skippedResult).resolves.toBe('latest result')
        await expect(latestResult).resolves.toBe('latest result')
    })

    it('continues with the latest request after a running task fails', async () => {
        const running = deferred<string>()
        const started: string[] = []
        const queue = createLatestTaskQueue<string, string>(async (request) => {
            started.push(request)
            if (request === 'first') return running.promise
            return `${request} result`
        })

        const firstResult = queue.enqueue('first')
        const latestResult = queue.enqueue('latest')
        running.reject(new Error('failed'))

        await expect(firstResult).rejects.toThrow('failed')
        await expect(latestResult).resolves.toBe('latest result')
        expect(started).toEqual(['first', 'latest'])
    })

    it('drops pending work when an immediate caller supersedes the queue', async () => {
        const running = deferred<string>()
        const started: string[] = []
        const queue = createLatestTaskQueue<string, string>(async (request) => {
            started.push(request)
            return request === 'first' ? running.promise : request
        })

        const firstResult = queue.enqueue('first')
        void queue.enqueue('stale')
        queue.clearPending()
        running.resolve('first result')

        await expect(firstResult).resolves.toBe('first result')
        expect(started).toEqual(['first'])
    })
})
