import { describe, expect, it } from 'vitest'
import { getRealmProxyUrl, PROXY_PATH } from '../../../../shared/proxy.mjs'
import { authorizePluginRequest } from './pluginNetworkPolicy'

const policy = {
    keiUrl: 'https://kei.example/app/',
    comfyUrls: ['http://localhost:8188', 'http://comfy.example:8188/api'],
    providerActive: false,
} as const

describe('authorizePluginRequest', () => {
    it('allows only read-only same-origin assets for ordinary plugin requests', () => {
        expect(authorizePluginRequest('/assets/plugin/icon.png', { ...policy, method: 'GET' }))
            .toEqual({ url: 'https://kei.example/assets/plugin/icon.png', useServer: false })
        expect(authorizePluginRequest('https://kei.example/assets/file.bin', { ...policy, method: 'HEAD' }))
            .toEqual({ url: 'https://kei.example/assets/file.bin', useServer: false })
        for (const url of [
            '/api/characters',
            PROXY_PATH,
            getRealmProxyUrl('/resource'),
            '/assets',
        ]) {
            expect(() => authorizePluginRequest(url, { ...policy, method: 'GET' })).toThrow()
        }
        expect(() => authorizePluginRequest('/assets/icon.png', { ...policy, method: 'POST' })).toThrow()
    })

    it('uses the direct route only for the configured Comfy bridge paths and methods', () => {
        expect(authorizePluginRequest('http://localhost:8188/prompt', { ...policy, method: 'POST' }))
            .toEqual({ url: 'http://localhost:8188/prompt', useServer: false })
        expect(authorizePluginRequest('http://localhost:8188/history', { ...policy, method: 'GET' }))
            .toEqual({ url: 'http://localhost:8188/history', useServer: false })
        expect(authorizePluginRequest('http://localhost:8188/view?filename=x.png', { ...policy, method: 'GET' }))
            .toEqual({ url: 'http://localhost:8188/view?filename=x.png', useServer: false })
        expect(authorizePluginRequest('http://comfy.example:8188/api/prompt', { ...policy, method: 'POST' }))
            .toEqual({ url: 'http://comfy.example:8188/api/prompt', useServer: false })
        expect(authorizePluginRequest('http://localhost:8188/queue', { ...policy, method: 'GET' }))
            .toEqual({ url: 'http://localhost:8188/queue', useServer: true })
        expect(authorizePluginRequest('http://localhost:8188/history', { ...policy, method: 'POST' }))
            .toEqual({ url: 'http://localhost:8188/history', useServer: true })
        expect(authorizePluginRequest('http://other.example:8188/prompt', { ...policy, method: 'POST' }))
            .toEqual({ url: 'http://other.example:8188/prompt', useServer: true })
    })

    it('allows arbitrary HTTP(S) provider traffic, including local endpoints, but keeps Kei restricted', () => {
        expect(authorizePluginRequest('https://api.example/token', { ...policy, providerActive: true, method: 'POST' }))
            .toEqual({ url: 'https://api.example/token', useServer: true })
        expect(authorizePluginRequest('http://192.168.1.22:5000/v1/models', { ...policy, providerActive: true, method: 'GET' }))
            .toEqual({ url: 'http://192.168.1.22:5000/v1/models', useServer: true })
        expect(authorizePluginRequest('http://localhost:8188/prompt', { ...policy, providerActive: true, method: 'POST' }))
            .toEqual({ url: 'http://localhost:8188/prompt', useServer: true })
        expect(() => authorizePluginRequest('https://kei.example/api/private', { ...policy, providerActive: true, method: 'GET' })).toThrow()
        expect(authorizePluginRequest('https://kei.example/assets/provider.png', { ...policy, providerActive: true, method: 'GET' }))
            .toEqual({ url: 'https://kei.example/assets/provider.png', useServer: false })
    })

    it('routes external discovery and update requests through server policy without requiring an active provider', () => {
        for (const url of ['https://update.rsyumi.workers.dev/provider-manager/version.json', 'https://update.rsyumi.workers.dev/provider-manager/providers.json', 'https://api.example/v1/models']) {
            expect(authorizePluginRequest(url, { ...policy, method: 'GET' }))
                .toEqual({ url, useServer: true })
        }
    })

    it('rejects non-HTTP URLs and embedded credentials', () => {
        expect(() => authorizePluginRequest('javascript:alert(1)', { ...policy, providerActive: true, method: 'GET' })).toThrow()
        expect(() => authorizePluginRequest('https://user:pass@api.example/v1', { ...policy, providerActive: true, method: 'GET' })).toThrow()
    })
})
