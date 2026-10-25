import markdownit from 'markdown-it'
import { expect, test } from 'vitest'
import { allowAttachedText } from '../attachedTextMarkdown'

const md = markdownit({ typographer: true, quotes: '«»‹›' })
allowAttachedText(md)

test.each([
    ["'토끼'가", '‹토끼›가'],
    ['그는"토끼"라고', '그는«토끼»라고'],
    ["'ウサギ'が", '‹ウサギ›が'],
    ['"rabbit"s', '«rabbit»s'],
    ['**"토끼"**가', '<strong>«토끼»</strong>가'],
    ['앞**"rabbit"**s', '앞<strong>«rabbit»</strong>s'],
    ["don't 'quote' it", 'don’t ‹quote› it'],
    ["'rabbit's tail'", '‹rabbit’s tail›'],
    ['5"3 tall', '5&quot;3 tall'],
    ['2*(3+4)*5', '2*(3+4)*5'],
])('%s', (input, expected) => {
    expect(md.renderInline(input)).toBe(expected)
})
