import { describe, expect, it, vi } from 'vitest'
import {
    clearPluginPermissionStateFor,
    permissionKeyOf,
    permissionLastGrantKeyOf,
    PluginPermissionDialogQueue,
    type PluginPermissionDesc,
    type PluginPermissionState,
} from './pluginPermissionState'

const makeState = (): PluginPermissionState => ({
    given: new Set(),
    denied: new Set(),
    cache: new Map(),
})

const resolvedFrom = (
    state: PluginPermissionState,
    pluginName: string,
    permission: PluginPermissionDesc,
    requiresReconfirm = false,
) => {
    const key = permissionKeyOf(pluginName, permission)
    if (!requiresReconfirm && state.given.has(key)) return { resolved: true, value: true, context: key }
    if (!requiresReconfirm && state.denied.has(key)) return { resolved: true, value: false, context: key }
    return { resolved: false, value: false, context: key }
}

const deferred = () => {
    let resolve!: (value: boolean) => void
    const promise = new Promise<boolean>((done) => { resolve = done })
    return { promise, resolve }
}

describe('PluginPermissionDialogQueue', () => {
    it('serializes concurrent permission dialogs', async () => {
        const queue = new PluginPermissionDialogQueue()
        const prompts = [deferred(), deferred(), deferred()]
        const started = [deferred(), deferred(), deferred()]
        let active = 0
        let maxActive = 0
        let promptIndex = 0
        const prompt = vi.fn(async () => {
            const index = promptIndex++
            const current = prompts[index]
            started[index].resolve(true)
            active++
            maxActive = Math.max(maxActive, active)
            const answer = await current.promise
            active--
            return answer
        })
        const unresolved = async () => ({ resolved: false, value: false, context: undefined })

        const results = [
            queue.request(unresolved, prompt),
            queue.request(unresolved, prompt),
            queue.request(unresolved, prompt),
        ]
        await started[0].promise
        expect(prompt).toHaveBeenCalledTimes(1)
        prompts[0].resolve(true)
        await started[1].promise
        expect(prompt).toHaveBeenCalledTimes(2)
        prompts[1].resolve(false)
        await started[2].promise
        expect(prompt).toHaveBeenCalledTimes(3)
        prompts[2].resolve(true)

        await expect(Promise.all(results)).resolves.toEqual([true, false, true])
        expect(maxActive).toBe(1)
    })

    it('uses a resolved permission without entering the dialog queue', async () => {
        const queue = new PluginPermissionDialogQueue()
        const prompt = vi.fn()

        await expect(queue.request(
            async () => ({ resolved: true, value: true, context: undefined }),
            prompt,
        )).resolves.toBe(true)
        expect(prompt).not.toHaveBeenCalled()
    })

    it('rechecks state under the lock so duplicate requests prompt once', async () => {
        const queue = new PluginPermissionDialogQueue()
        const state = makeState()
        const prompt = vi.fn(async (key: string) => {
            state.given.add(key)
            return true
        })
        const resolve = async () => resolvedFrom(state, 'Plug', 'db')

        await expect(Promise.all([
            queue.request(resolve, prompt),
            queue.request(resolve, prompt),
        ])).resolves.toEqual([true, true])
        expect(prompt).toHaveBeenCalledOnce()
    })

    it('recomputes periodic confirmation after an earlier queued grant', async () => {
        const queue = new PluginPermissionDialogQueue()
        const state = makeState()
        const now = 1_000_000
        const key = permissionKeyOf('Plug', 'replacer')
        const resolve = async () => {
            const lastGrant = state.cache.get(permissionLastGrantKeyOf('Plug', 'replacer')) as number | undefined
            return resolvedFrom(state, 'Plug', 'replacer', !lastGrant || now - lastGrant > 100)
        }
        const prompt = vi.fn(async () => {
            state.given.add(key)
            state.cache.set(permissionLastGrantKeyOf('Plug', 'replacer'), now)
            return true
        })

        await expect(Promise.all(Array.from({ length: 4 }, () =>
            queue.request(resolve, prompt),
        ))).resolves.toEqual([true, true, true, true])
        expect(prompt).toHaveBeenCalledOnce()
    })

    it('continues with later dialogs after one prompt throws', async () => {
        const queue = new PluginPermissionDialogQueue()
        const unresolved = async () => ({ resolved: false, value: false, context: undefined })
        const first = queue.request(unresolved, async () => { throw new Error('boom') })
        const second = queue.request(unresolved, async () => true)

        await expect(first).rejects.toThrow('boom')
        await expect(second).resolves.toBe(true)
    })
})

describe('plugin permission state keys', () => {
    it('keeps plugin names, permissions, and legacy underscore keys disjoint', () => {
        expect(permissionKeyOf('foo', 'db')).not.toBe('foo_db')
        expect(permissionKeyOf('foo', 'db')).not.toBe(permissionKeyOf('foo_db', 'fetchLogs'))
        expect(permissionKeyOf('foo', 'db')).not.toBe(permissionKeyOf('foo', 'provider'))
    })

    it('grants and denies each permission independently', async () => {
        const queue = new PluginPermissionDialogQueue()
        const state = makeState()
        const ask = (permission: PluginPermissionDesc, answer: boolean) => queue.request(
            async () => resolvedFrom(state, 'Plug', permission),
            async (key) => {
                (answer ? state.given : state.denied).add(key)
                return answer
            },
        )

        await expect(ask('fetchLogs', true)).resolves.toBe(true)
        await expect(ask('db', false)).resolves.toBe(false)
        expect(state.given).toContain(permissionKeyOf('Plug', 'fetchLogs'))
        expect(state.denied).toContain(permissionKeyOf('Plug', 'db'))
    })

    it('reset removes only the selected plugin, including legacy and timestamp entries', () => {
        const state = makeState()
        state.given.add('foo')
        state.given.add(permissionKeyOf('foo', 'db'))
        state.denied.add(permissionKeyOf('foo', 'provider'))
        state.cache.set(permissionLastGrantKeyOf('foo', 'db'), 111)
        state.given.add(permissionKeyOf('foo_bar', 'db'))
        state.cache.set(permissionLastGrantKeyOf('foo_bar', 'db'), 222)

        clearPluginPermissionStateFor(state, 'foo')

        expect(state.given).toEqual(new Set([permissionKeyOf('foo_bar', 'db')]))
        expect(state.denied).toEqual(new Set())
        expect(state.cache).toEqual(new Map([[permissionLastGrantKeyOf('foo_bar', 'db'), 222]]))
    })
})
