import { describe, expect, it, vi } from 'vitest'
import { createComfyUrl } from '../../src/ts/network/comfyUrl'

const { getConfiguredLocalUrls, createConfiguredLocalUrlProvider } = require('./configuredNetworkTargets.cjs') as {
    getConfiguredLocalUrls: (database: Record<string, unknown>) => string[]
    createConfiguredLocalUrlProvider: (store: { getState(): { revision: number }, exportProjection(options: { includeMessages: boolean }): unknown }) => () => string[]
}

function modelPreset(
    adapterKind: string,
    endpointUrl: string,
    overrides: Record<string, unknown> = {},
) {
    return {
        id: `${adapterKind}-preset`,
        name: `${adapterKind} preset`,
        profileSnapshot: {
            profileId: `${adapterKind}-profile`,
            providerBaseId: adapterKind,
            adapterKind,
            auth: { kind: 'bearer', fields: ['apiKey'] },
            endpoint: { kind: 'static', url: endpointUrl },
            modelId: 'model',
            schema: [{
                key: 'endpointUrl',
                type: 'string',
                label: 'Endpoint URL',
                mapsTo: { target: 'custom', path: 'endpointUrl' },
            }],
            uiSchema: { groups: [], fields: [] },
            defaults: {},
        },
        userValues: {},
        createdAt: 1,
        updatedAt: 1,
        ...overrides,
    }
}

describe('configured network targets', () => {
    it('reuses target derivation within a revision and revokes old endpoints when settings change', async () => {
        const { createOutboundPolicy } = require('./outboundPolicy.cjs')
        let revision = 1
        let embeddingUrl = 'http://127.0.0.1:8000/old'
        const exportProjection = vi.fn(() => ({ hypaCustomSettings: { url: embeddingUrl } }))
        const getAllowedLocalUrls = createConfiguredLocalUrlProvider({
            getState: () => ({ revision }), exportProjection,
        })
        const policy = createOutboundPolicy({ getAllowedLocalUrls })
        try {
            const first = await policy.prepare(embeddingUrl + '/embeddings')
            first.release()
            const again = await policy.prepare(embeddingUrl + '/embeddings')
            again.release()
            expect(exportProjection).toHaveBeenCalledOnce()

            embeddingUrl = 'http://127.0.0.1:8000/new'
            revision++
            await expect(policy.prepare('http://127.0.0.1:8000/old/embeddings')).rejects.toMatchObject({ code: 'OUTBOUND_TARGET_BLOCKED' })
            const updated = await policy.prepare(embeddingUrl + '/embeddings')
            expect(updated.url).toBe(embeddingUrl + '/embeddings')
            updated.release()
        } finally {
            await policy.close()
        }
    })

    it('uses the persisted model endpoint override and isolates invalid, plugin, and echo presets', () => {
        const target = 'http://model-server:11434/v1/chat/completions'
        const urls = getConfiguredLocalUrls({
            modelPresets: [
                modelPreset('openai-compatible', 'https://provider.example/v1', {
                    userValues: { endpointUrl: target },
                }),
                modelPreset('plugin', 'http://plugin-server:8080/generate'),
                modelPreset('echo', 'http://echo-server:8080/generate'),
                { profileSnapshot: { adapterKind: 'unknown' } },
            ],
        })

        expect(urls).toContain(target)
        expect(urls).not.toContain('http://plugin-server:8080/generate')
        expect(urls).not.toContain('http://echo-server:8080/generate')
        expect(urls).toHaveLength(1)
    })

    it('uses the selected OpenAI API mode endpoint for local model presets', () => {
        const preset = modelPreset(
            'openai-compatible',
            'http://model-server:11434/v1/chat/completions',
        )
        preset.profileSnapshot.schema.push({
            key: 'openaiApiMode',
            type: 'string',
            label: 'API mode',
            default: 'completions',
            mapsTo: { target: 'custom', path: 'apiMode' },
        })
        preset.userValues = { openaiApiMode: 'responses' }

        expect(getConfiguredLocalUrls({ modelPresets: [preset] })).toEqual([
            'http://model-server:11434/v1/responses',
        ])
    })

    it('adds configured embedding, GPT-SoVITS, and current ComfyUI request URLs', () => {
        const urls = getConfiguredLocalUrls({
            hypaCustomSettings: { url: 'http://embedding-server:8000/v1/' },
            ttsPresets: [
                { settings: { provider: 'fishspeech', gptSoVits: { url: 'http://unused:1' } } },
                { settings: { provider: 'gptsovits', gptSoVits: { url: 'http://voice-server:9880/' } } },
            ],
            imageGenerationPresetId: 1,
            imageGenerationPresets: [
                { settings: { sdProvider: 'comfyui', comfyUiUrl: 'http://unselected:8188' } },
                { settings: { sdProvider: 'comfyui', comfyUiUrl: 'http://comfy-server:8188/api' } },
            ],
        })

        expect(urls).toEqual([
            'http://embedding-server:8000/v1/embeddings',
            'http://voice-server:9880/tts',
            'http://comfy-server:8188/api/prompt',
            'http://comfy-server:8188/api/history',
            'http://comfy-server:8188/api/view',
        ])
    })

    it('matches ComfyUI root-relative paths when the configured base has another prefix', () => {
        const urls = getConfiguredLocalUrls({
            imageGenerationPresetId: 0,
            imageGenerationPresets: [
                { settings: { sdProvider: 'comfyui', comfyUiUrl: 'http://comfy-server:8188/comfy/' } },
            ],
        })

        expect(urls).toEqual([
            'http://comfy-server:8188/prompt',
            'http://comfy-server:8188/history',
            'http://comfy-server:8188/view',
        ])
        expect(() => createComfyUrl('http://user:secret@comfy-server:8188', '/prompt'))
            .toThrow('Invalid local ComfyUI URL')
    })

    it('keeps configured hostnames canonical for DNS-pinned private endpoints', () => {
        const localFqdn = 'http://comfy.example:8188/api/v1/chat/completions'
        const urls = getConfiguredLocalUrls({
            modelPresets: [
                modelPreset('openai-compatible', localFqdn),
                modelPreset('openai-compatible', 'https://api.example.com/v1/chat/completions'),
                modelPreset('openai-compatible', 'http://user:secret@credentialed.example/v1'),
            ],
        })

        expect(urls).toEqual([
            localFqdn,
            'https://api.example.com/v1/chat/completions',
        ])
    })
})
