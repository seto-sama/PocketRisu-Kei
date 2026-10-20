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

    it('returns cyclic binary values without duplicating shared buffers in the transfer list', async () => {
        const addListener = vi.spyOn(window, 'addEventListener')
        const iframe = document.createElement('iframe')
        document.body.appendChild(iframe)
        const backing = new ArrayBuffer(4)
        new Uint8Array(backing).set([1, 2, 3, 4])
        const value: any = { buffer: backing, view: new Uint8Array(backing) }
        value.self = value
        value.map = new Map([['view', value.view]])
        const host = new SandboxHost({ read: () => value })
        host.run(iframe, '')

        const postMessage = vi.fn((_message: any, _targetOrigin?: string | WindowPostMessageOptions, _transfer?: Transferable[]) => {})
        vi.spyOn(iframe.contentWindow!, 'postMessage').mockImplementation(postMessage)
        const registration = addListener.mock.calls.find(([type]) => type === 'message')!
        const handler = registration[1] as (event: MessageEvent) => Promise<void>
        await handler(new MessageEvent('message', {
            source: iframe.contentWindow,
            data: { type: 'CALL_ROOT', reqId: 'read-binary', method: 'read', args: [] },
        }))

        const [response, , transferables] = postMessage.mock.calls[0]
        expect(response.error).toBeUndefined()
        expect(transferables).toEqual([backing])
        const received = structuredClone(response.result, { transfer: transferables })
        expect(received.self).toBe(received)
        expect(received.map.get('view').buffer).toBe(received.buffer)
        expect(Array.from(received.view)).toEqual([1, 2, 3, 4])
        host.terminate()
    })
})
