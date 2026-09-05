import { beforeEach, describe, expect, test, vi } from 'vitest'
import type { character } from '../storage/database.svelte'

const parser = vi.hoisted(() => vi.fn())
const tokenize = vi.hoisted(() => vi.fn())

vi.mock(import('../parser/parser.svelte'), () => ({
    risuChatParser: parser,
}))

vi.mock(import('../tokenizer'), () => ({ tokenize }))

import {
    renderLorebookContent,
    selectLorebookPromptsWithinBudget,
} from './lorebookPrompt'

describe('lorebook prompt preparation', () => {
    const char = { name: 'Risu' } as character

    beforeEach(() => {
        parser.mockReset()
        tokenize.mockReset()
        parser.mockImplementation((content: string) => content.replace('{{#if 0}}hidden{{/}}', ''))
        tokenize.mockImplementation(async (text: string) => text.length)
    })

    test('uses the shared CBS rendering boundary', () => {
        expect(renderLorebookContent('{{#if 0}}hidden{{/}}visible', char)).toBe('visible')
        expect(parser).toHaveBeenCalledWith('{{#if 0}}hidden{{/}}visible', { chara: char })
    })

    test('budgets rendered text by priority and returns insertion order', async () => {
        const selected = await selectLorebookPromptsWithinBudget([
            { id: 'hidden', prompt: '{{#if 0}}hidden{{/}}1234', priority: 30, order: 1 },
            { id: 'too-large', prompt: '123456', priority: 20, order: 2 },
            { id: 'fits', prompt: '123', priority: 10, order: 3 },
        ], 7, char)

        expect(selected.map(({ id, tokens }) => ({ id, tokens }))).toEqual([
            { id: 'fits', tokens: 3 },
            { id: 'hidden', tokens: 4 },
        ])
        expect(tokenize).toHaveBeenCalledWith('1234')
        expect(tokenize).not.toHaveBeenCalledWith('{{#if 0}}hidden{{/}}1234')
    })

    test('keeps zero-token prompts when the budget is already full', async () => {
        const selected = await selectLorebookPromptsWithinBudget([
            { id: 'full', prompt: '123', priority: 2, order: 1 },
            { id: 'empty', prompt: '', priority: 1, order: 2 },
        ], 3, char)

        expect(selected.map(({ id }) => id)).toEqual(['empty', 'full'])
    })
})
