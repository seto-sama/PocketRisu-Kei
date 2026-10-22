import { describe, expect, it, vi } from 'vitest'
import { PluginPermissionDialogQueue } from './pluginPermissionState'

const deferred = () => {
    let resolve!: (value: boolean) => void
    const promise = new Promise<boolean>((done) => { resolve = done })
    return { promise, resolve }
}

describe('PluginPermissionDialogQueue', () => {
    it('serializes dialogs while returning already resolved decisions immediately', async () => {
        const queue = new PluginPermissionDialogQueue()
        const prompts = [deferred(), deferred()]
        const started = [deferred(), deferred()]
        let index = 0
        const prompt = vi.fn(async () => {
            const current = index++
            started[current].resolve(true)
            return prompts[current].promise
        })
        const unresolved = async () => undefined
        const first = queue.request(unresolved, prompt)
        const second = queue.request(unresolved, prompt)
        await started[0].promise
        expect(prompt).toHaveBeenCalledOnce()

        await expect(queue.request(async () => false, prompt)).resolves.toBe(false)
        expect(prompt).toHaveBeenCalledOnce()
        prompts[0].resolve(true)
        await started[1].promise
        prompts[1].resolve(false)
        await expect(Promise.all([first, second])).resolves.toEqual([true, false])
    })

    it.each([true, false])('reuses an earlier queued decision (%s) without another prompt', async answer => {
        const queue = new PluginPermissionDialogQueue()
        let decision: boolean | undefined
        const prompt = vi.fn(async () => {
            decision = answer
            return answer
        })
        const resolve = async () => decision
        await expect(Promise.all([
            queue.request(resolve, prompt),
            queue.request(resolve, prompt),
        ])).resolves.toEqual([answer, answer])
        expect(prompt).toHaveBeenCalledOnce()
    })

    it('continues with later dialogs after one prompt throws', async () => {
        const queue = new PluginPermissionDialogQueue()
        const unresolved = async () => undefined
        const first = queue.request(unresolved, async () => { throw new Error('boom') })
        const second = queue.request(unresolved, async () => true)
        await expect(first).rejects.toThrow('boom')
        await expect(second).resolves.toBe(true)
    })
})
