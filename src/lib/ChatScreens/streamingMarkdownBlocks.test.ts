import { describe, expect, it, vi } from 'vitest'
import MarkdownIt from 'markdown-it'
import {
    splitStableMarkdownBlocks,
    StreamingMarkdownBlockRenderer,
} from './streamingMarkdownBlocks'

describe('stable streaming Markdown blocks', () => {
    it('freezes complete prose blocks and retains the unfinished tail', () => {
        expect(splitStableMarkdownBlocks('First paragraph.\n\nSecond paragraph.\n\nTail')).toEqual({
            stableBlocks: ['First paragraph.\n\n', 'Second paragraph.\n\n'],
            tail: 'Tail',
        })
    })

    it('keeps context-sensitive Markdown and everything after it mutable', () => {
        expect(splitStableMarkdownBlocks('Safe.\n\n- list item\n\nLater.\n\nTail')).toEqual({
            stableBlocks: ['Safe.\n\n'],
            tail: '- list item\n\nLater.\n\nTail',
        })
        expect(splitStableMarkdownBlocks('<Thoughts>open\n\nStill open')).toEqual({
            stableBlocks: [],
            tail: '<Thoughts>open\n\nStill open',
        })
    })

    it('parses stable blocks once and only reparses the changing tail', async () => {
        const parse = vi.fn(async (source: string) => `<p>${source.trim()}</p>`)
        const renderer = new StreamingMarkdownBlockRenderer()

        const first = await renderer.render('One.\n\nTw', 'message', parse)
        const second = await renderer.render('One.\n\nTwo.\n\nTh', 'message', parse)

        expect(first.stableBlocks.map(block => block.source)).toEqual(['One.\n\n'])
        expect(second.stableBlocks.map(block => block.source)).toEqual(['One.\n\n', 'Two.\n\n'])
        expect(second.stableBlocks[0]).toBe(first.stableBlocks[0])
        expect(parse.mock.calls.map(([source]) => source)).toEqual([
            'One.\n\n',
            'Tw',
            'Two.\n\n',
            'Th',
        ])
    })

    it('invalidates cached blocks when prepared source or context changes', async () => {
        const parse = vi.fn(async (source: string) => source.toUpperCase())
        const renderer = new StreamingMarkdownBlockRenderer()

        await renderer.render('One.\n\nTail', 'message:a', parse)
        await renderer.render('Changed.\n\nTail', 'message:a', parse)
        await renderer.render('Changed.\n\nTail', 'message:b', parse)

        expect(parse.mock.calls.filter(([source]) => source === 'Changed.\n\n')).toHaveLength(2)
    })

    it('matches a full Markdown render for blocks classified as stable', async () => {
        const markdown = new MarkdownIt()
        const source = '# Heading\n\nFirst **bold** paragraph.\n\nMutable tail'
        const renderer = new StreamingMarkdownBlockRenderer()
        const incremental = await renderer.render(
            source,
            'message',
            async part => markdown.render(part),
        )

        expect(incremental.html).toBe(markdown.render(source))
    })

    it('discards incremental blocks and performs one canonical final parse', async () => {
        const parse = vi.fn(async (source: string) => source.toUpperCase())
        const renderer = new StreamingMarkdownBlockRenderer()
        await renderer.render('Stable.\n\nTail', 'message', parse)
        parse.mockClear()

        await expect(renderer.renderFinal('Stable.\n\nFinished.', parse))
            .resolves.toBe('STABLE.\n\nFINISHED.')
        expect(parse).toHaveBeenCalledOnce()
        expect(parse).toHaveBeenCalledWith('Stable.\n\nFinished.')

        parse.mockClear()
        await renderer.render('Stable.\n\nNew tail', 'message', parse)
        expect(parse).toHaveBeenCalledWith('Stable.\n\n')
    })
})
