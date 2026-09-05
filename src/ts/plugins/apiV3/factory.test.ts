import { afterEach, describe, expect, it, vi } from 'vitest'
import { SandboxHost } from './factory'

describe('SandboxHost lifecycle', () => {
    afterEach(() => {
        vi.restoreAllMocks()
        document.body.replaceChildren()
    })

    it('removes its message listener when the plugin is terminated', () => {
        const addListener = vi.spyOn(window, 'addEventListener')
        const removeListener = vi.spyOn(window, 'removeEventListener')
        const iframe = document.createElement('iframe')
        document.body.appendChild(iframe)
        const host = new SandboxHost({})

        host.run(iframe, '')
        const registration = addListener.mock.calls.find(([type]) => type === 'message')
        expect(registration).toBeDefined()

        host.terminate()
        expect(removeListener).toHaveBeenCalledWith('message', registration?.[1])

        const removals = removeListener.mock.calls.filter(([type]) => type === 'message').length
        host.terminate()
        expect(removeListener.mock.calls.filter(([type]) => type === 'message')).toHaveLength(removals)
    })
})
