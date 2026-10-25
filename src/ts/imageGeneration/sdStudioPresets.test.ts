import { describe, expect, it } from 'vitest'
import { parseSDStudioPresets } from './sdStudioPresets'

describe('SDStudio preset prompts', () => {
    it('expands enabled slot combinations in scene order, preserving weights and removing external pieces', () => {
        const slot = (prompt: string, enabled = true) => ({ prompt, enabled })
        const prompts = parseSDStudioPresets(JSON.stringify({
            presets: { default: { frontPrompt: 'quality', backPrompt: 'style', uc: 'negative', steps: 1 } },
            scenes: {
                smile: { slots: [
                    [slot('{{smile}}, <예시 보관함.조각 이름>, [[shaded face]]'), slot('grin'), slot('hidden', false)],
                    [slot('standing'), slot('sitting')],
                ] },
                angry: { slots: [[slot('angry, <sample_library.eyes>')]] },
                disabled: { slots: [[slot('hidden', false)]] },
            },
        }))
        expect(prompts).toEqual([
            { name: 'smile', prompt: '{{smile}}, [[shaded face]],\nstanding' },
            { name: 'smile', prompt: '{{smile}}, [[shaded face]],\nsitting' },
            { name: 'smile', prompt: 'grin,\nstanding' },
            { name: 'smile', prompt: 'grin,\nsitting' },
            { name: 'angry', prompt: 'angry' },
        ])
    })

    it('rejects invalid files and projects without usable prompts', () => {
        for (const json of ['{', '{"pieces":[]}', '{"scenes":{"empty":{"slots":[]}}}', '{"scenes":{"invalid":{"slots":[[{}]]}}}']) {
            expect(() => parseSDStudioPresets(json)).toThrow()
        }
    })
})
