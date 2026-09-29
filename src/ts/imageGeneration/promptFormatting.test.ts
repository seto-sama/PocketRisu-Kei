import { describe, expect, it } from 'vitest'
import { formatComfyUIPrompt, formatNovelAIPrompt } from '../../../server/node/imagePromptFormatting.mjs'

describe('image generation prompt formatting', () => {
    it('converts weighted parentheses for NovelAI and unescapes literal parentheses', () => {
        expect(formatNovelAIPrompt(
            '(@placeholder_artist : +.6), (masterpiece:1.2), (artist:placeholder_creator (placeholder_group)), \\(literal\\)',
        )).toBe(
            '+.6::@placeholder_artist::, 1.2::masterpiece::, (artist:placeholder_creator (placeholder_group)), (literal)',
        )
        expect(formatNovelAIPrompt('(@placeholder_artist:0.6)', true))
            .toBe('0.6::artist:placeholder_artist::')
    })

    it('removes Comfy literal-parenthesis escapes for NovelAI without treating them as weights', () => {
        const prompt = String.raw`portrait \(group\), \(detail:1.2\), (masterpiece:1.2)`

        expect(formatNovelAIPrompt(prompt))
            .toBe('portrait (group), (detail:1.2), 1.2::masterpiece::')
        expect(formatComfyUIPrompt(prompt))
            .toBe(String.raw`portrait \(group\), \(detail:1.2\), (masterpiece:1.2)`)
    })

    it('converts NAI weights for ComfyUI and escapes only literal parentheses', () => {
        expect(formatComfyUIPrompt(
            '0.9::artist:placeholder_creator {placeholder_group}::, (masterpiece:1.3), (@placeholder_artist:0.6), (artist:placeholder_creator (placeholder_group)), \\(literal\\)',
        )).toBe(
            '(artist:placeholder_creator {placeholder_group}:0.9), (masterpiece:1.3), (@placeholder_artist:0.6), \\(artist:placeholder_creator \\(placeholder_group\\)\\), \\(literal\\)',
        )
        expect(formatComfyUIPrompt('0.6::artist:placeholder_artist::', true))
            .toBe('(@placeholder_artist:0.6)')
        expect(formatComfyUIPrompt('0.6::artist:placeholder_artist::'))
            .toBe('(artist:placeholder_artist:0.6)')
    })

    it('preserves a NAI-style weight sign and fractional notation when formatting for ComfyUI', () => {
        expect(formatComfyUIPrompt('-.75::detail::')).toBe('(detail:-.75)')
    })

    it('keeps weighted outer parentheses while escaping ordinary parentheses in their content', () => {
        expect(formatComfyUIPrompt('0.9::artist:placeholder_creator (placeholder_group)::'))
            .toBe('(artist:placeholder_creator \\(placeholder_group\\):0.9)')
        expect(formatComfyUIPrompt('(artist:placeholder_creator (placeholder_group):0.9)'))
            .toBe('(artist:placeholder_creator \\(placeholder_group\\):0.9)')
    })
})
