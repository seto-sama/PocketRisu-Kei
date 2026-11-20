import { expect, it, vi } from 'vitest'
import type { PromptItem } from './prompt'

vi.mock('../tokenizer', () => ({
    tokenizeAccurate: async (text: string, consistantChar?: boolean) => consistantChar ? text.length : NaN,
    tokenize: async (text: string) => text.length * 10,
}))

const { tokenizePreset } = await import('./prompt')

it('counts only the fixed text each prompt block contributes', async () => {
    const template: PromptItem[] = [
        { type: 'plain', type2: 'main', text: 'a', role: 'system' },
        { type: 'jailbreak', type2: 'normal', text: 'bb', role: 'system' },
        { type: 'persona', innerFormat: 'ccc' },
        { type: 'description' },
        { type: 'authornote', innerFormat: 'dddd', defaultText: 'not counted' },
        { type: 'chat', rangeStart: 0, rangeEnd: 'end' },
        { type: 'cache', name: 'cache', depth: 1, role: 'all' },
        { type: 'chatML', text: '<|im_start|>system\neeeee<|im_end|>\n<|im_start|>user\nff<Thoughts>skip</Thoughts><|im_end|>' },
        { type: 'chatML', text: 'not chatml, so nothing is sent' },
    ]

    expect(await tokenizePreset(template)).toBe(1 + 2 + 3 + 4 + 5 + 2)
    expect(await tokenizePreset(template, 'raw')).toBe((1 + 2 + 3 + 4 + 5 + 2) * 10)
    expect(await tokenizePreset([{ type: 'memory', innerFormat: 'gg{{slot}}' }], 'raw')).toBe(20)
})
