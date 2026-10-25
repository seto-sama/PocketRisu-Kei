import { expect, it, vi } from 'vitest'
import { encodeWithTokenizer } from './tokenizer'

vi.mock('./storage/database.svelte', () => ({ getCurrentCharacter: vi.fn() }))
vi.mock('./process/files/inlays', () => ({ supportsInlayImage: () => false }))
vi.mock('./parser/parser.svelte', () => ({ risuChatParser: (text: string) => text }))
vi.mock('./process/models/modelString', () => ({
    getGenerationModelPreset: () => undefined,
    getModelPresetMetadata: () => ({}),
    getModelPresetTokenizer: () => 'tik',
}))

it('uses o200k for the OpenAI tokenizer and legacy fallback identifiers', async () => {
    const text = '안녕하세요, 세계! Hello world.'
    for (const tokenizer of ['tik', 'mistral', 'novelai', 'llama', 'novellist', 'unknown']) {
        expect((await encodeWithTokenizer(text, tokenizer)).length).toBe(8)
    }
})
