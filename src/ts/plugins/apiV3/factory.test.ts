import { afterEach, describe, expect, it, vi } from 'vitest'
import { SandboxHost } from './factory'

describe('SandboxHost lifecycle', () => {
    afterEach(() => {
        vi.restoreAllMocks()
        document.body.replaceChildren()
    })

    it('stops serving RPC requests after the plugin is terminated', async () => {
        const iframe = document.createElement('iframe')
        document.body.appendChild(iframe)
        const ping = vi.fn(async () => 'pong')
        const host = new SandboxHost({ ping })

        host.run(iframe, '')
        let resolveResponse!: (message: any) => void
        const responsePromise = new Promise<any>(resolve => { resolveResponse = resolve })
        const postMessage = vi.spyOn(iframe.contentWindow!, 'postMessage').mockImplementation((message: any) => {
            resolveResponse(message)
        })
        const sendRequest = (reqId: string) => window.dispatchEvent(new MessageEvent('message', {
            source: iframe.contentWindow,
            data: { type: 'CALL_ROOT', reqId, method: 'ping', args: [] },
        }))

        sendRequest('before-termination')
        await expect(responsePromise).resolves.toMatchObject({
            type: 'RESPONSE', reqId: 'before-termination', result: 'pong',
        })
        expect(ping).toHaveBeenCalledOnce()

        host.terminate()
        postMessage.mockClear()
        sendRequest('after-termination')
        await new Promise(resolve => setTimeout(resolve, 0))
        expect(ping).toHaveBeenCalledOnce()
        expect(postMessage).not.toHaveBeenCalled()
    })

    it('emits the configured CSP and uses its nonce in the bootstrap script', () => {
        const iframe = document.createElement('iframe')
        document.body.appendChild(iframe)
        const host = new SandboxHost({})
        host.run(iframe, '')

        const csp = iframe.getAttribute('csp')!
        const srcdoc = new DOMParser().parseFromString(iframe.srcdoc, 'text/html')
        expect(srcdoc.querySelector('meta#csp-meta')?.getAttribute('content')).toBe(csp)
        const nonce = srcdoc.querySelector('script[nonce]')?.getAttribute('nonce')
        expect(nonce).toBeTruthy()
        expect(csp).toContain(`'nonce-${nonce}'`)
        expect(csp).toContain("connect-src 'none'")
        expect(csp).toContain(`img-src ${window.location.origin}/assets/ data: blob:`)

        host.terminate()
    })

    it('returns cyclic values with shared binary buffers intact', async () => {
        const iframe = document.createElement('iframe')
        document.body.appendChild(iframe)
        const backing = new ArrayBuffer(4)
        new Uint8Array(backing).set([1, 2, 3, 4])
        const value: any = { buffer: backing, view: new Uint8Array(backing) }
        value.self = value
        value.map = new Map([['view', value.view]])
        const host = new SandboxHost({ read: () => value })
        host.run(iframe, '')

        const responsePromise = new Promise<any>(resolve => {
            vi.spyOn(iframe.contentWindow!, 'postMessage').mockImplementation((message: any, _origin?: string | WindowPostMessageOptions, transfer?: Transferable[]) => {
                resolve(structuredClone(message, { transfer }))
            })
        })
        window.dispatchEvent(new MessageEvent('message', {
            source: iframe.contentWindow,
            data: { type: 'CALL_ROOT', reqId: 'read-binary', method: 'read', args: [] },
        }))

        const response = await responsePromise
        expect(response.error).toBeUndefined()
        const received = response.result
        expect(received.self).toBe(received)
        expect(received.map.get('view').buffer).toBe(received.buffer)
        expect(Array.from(received.view)).toEqual([1, 2, 3, 4])
        host.terminate()
    })
})
