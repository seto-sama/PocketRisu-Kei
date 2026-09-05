import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../../storage/database.svelte', () => ({
    getDatabase: () => ({}),
}))
vi.mock('../../../imageGeneration/presets', () => ({
    getCurrentImageGenerationPreset: () => ({
        settings: {
            sdProvider: 'comfyui',
            comfyUiUrl: 'http://127.0.0.1:8818',
            comfyConfig: {
                timeout: 30,
                workflow: JSON.stringify({
                    positive: { inputs: { text: '{{risu_prompt}}' } },
                    negative: { inputs: { text: '{{risu_neg}}' } },
                    sampler: { inputs: { seed: 1, cfg: 7 } },
                }),
            },
        },
    }),
}))
vi.mock('../transport/client', () => ({
    createRevenantGenerationAuth: async () => 'auth',
    getRevenantGenerationSyncClientId: () => 'page-1',
}))

import { serviceComfyBridgeJob } from './comfyBridge'
import { getComfyBridgeId } from './comfyBridgeId'

describe('restricted local ComfyUI bridge', () => {
    beforeEach(() => {
        localStorage.clear()
        vi.unstubAllGlobals()
        vi.stubGlobal('WebSocket', class {
            onmessage?: (event: { data: string }) => void
            onerror?: () => void
            constructor(_url: URL) {}
            close() {}
        })
    })

    it('uses only the local preset workflow and uploads its bound prompt result', async () => {
        const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
            const url = String(input)
            if (url === 'http://127.0.0.1:8818/prompt') {
                return new Response(JSON.stringify({ prompt_id: 'prompt-1' }), { status: 200 })
            }
            if (url === 'http://127.0.0.1:8818/history') {
                return new Response(JSON.stringify({
                    'prompt-1': {
                        status: { status_str: 'success', messages: [] },
                        outputs: { image: { images: [{ filename: 'result.png', type: 'output' }] } },
                    },
                }), { status: 200 })
            }
            if (url.startsWith('http://127.0.0.1:8818/view?')) {
                return new Response(new Uint8Array([9, 8, 7]), {
                    status: 200,
                    headers: { 'content-type': 'image/png' },
                })
            }
            if (url.endsWith('/comfy/submitted') || url.endsWith('/comfy/complete')) {
                return new Response('{}', { status: 200 })
            }
            throw new Error(`Unexpected fetch: ${url} ${init?.method}`)
        })
        vi.stubGlobal('fetch', fetchMock)

        await serviceComfyBridgeJob('workflow:image', {
            provider: 'comfyui',
            status: 'waiting_client',
            bridgeId: getComfyBridgeId(),
            bridgeRequest: { prompt: 'portrait', negativePrompt: 'blur', seed: 42 },
        })

        const promptCall = fetchMock.mock.calls.find(([url]) => String(url).endsWith('/prompt'))
        const promptBody = JSON.parse(String(promptCall?.[1]?.body))
        expect(promptBody.prompt).toEqual({
            positive: { inputs: { text: 'portrait' } },
            negative: { inputs: { text: 'blur' } },
            sampler: { inputs: { seed: 42, cfg: 7 } },
        })
        const completeCall = fetchMock.mock.calls.find(([url]) => String(url).endsWith('/comfy/complete'))
        const completeBody = JSON.parse(String(completeCall?.[1]?.body))
        expect(completeBody).toMatchObject({
            promptId: 'prompt-1',
            resultBase64: 'CQgH',
            resultFormat: 'png',
        })
        expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/proxy2'))).toBe(false)
    })

    it('resumes an attached prompt after reload without submitting it again', async () => {
        const fetchMock = vi.fn(async (input: string | URL) => {
            const url = String(input)
            if (url === 'http://127.0.0.1:8818/history') {
                return new Response(JSON.stringify({
                    'prompt-existing': {
                        status: { status_str: 'success', messages: [] },
                        outputs: { image: { images: [{ filename: 'result.png', type: 'output' }] } },
                    },
                }), { status: 200 })
            }
            if (url.startsWith('http://127.0.0.1:8818/view?')) {
                return new Response(new Uint8Array([1]), {
                    status: 200,
                    headers: { 'content-type': 'image/png' },
                })
            }
            if (url.endsWith('/comfy/submitted') || url.endsWith('/comfy/complete')) {
                return new Response('{}', { status: 200 })
            }
            throw new Error(`Unexpected fetch: ${url}`)
        })
        vi.stubGlobal('fetch', fetchMock)

        await serviceComfyBridgeJob('workflow:resume', {
            provider: 'comfyui',
            status: 'generating',
            bridgeId: getComfyBridgeId(),
            bridgeRequest: { prompt: 'portrait', negativePrompt: '', seed: 42 },
            providerHandle: { promptId: 'prompt-existing', clientId: 'client-existing' },
        })

        expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith('/prompt'))).toBe(false)
        expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith('/comfy/complete'))).toBe(true)
    })
})
