import { CompletionContext } from '@codemirror/autocomplete'
import { EditorState } from '@codemirror/state'
import type { EditorView } from '@codemirror/view'
import { expect, it, vi } from 'vitest'
import { createImageTagCompletionSource, getImageTagRange } from './imageTags'

vi.mock('../storage/autoStorage', () => ({ forageStorage: { createAuth: vi.fn() } }))

it('completes the typed prefix with a separator while preserving following text and weights', () => {
    for (const [marked, expected] of [
        ['head<cursor> out', 'long hair, out'],
        ['head<cursor>', 'long hair, '],
        ['1girl, (긴 머리<cursor>:+.6), blue eyes', '1girl, (long hair:+.6), blue eyes'],
        ['A girl smiles. +.6::긴 머리<cursor>::|out', 'A girl smiles. +.6::long hair::|out'],
        ['{{char}} | 장발<cursor> | blue eyes', '{{char}} | long hair | blue eyes'],
        ['1girl, {긴 머리<cursor>}', '1girl, {long hair}, '],
        ['artist:토리야마 아키라<cursor>, 1girl', 'artist:long hair, 1girl'],
        ['head<cursor>\nout', 'long hair\nout'],
    ]) {
        const cursor = marked.indexOf('<cursor>')
        const text = marked.replace('<cursor>', '')
        const range = getImageTagRange(text, cursor)!
        expect(text.slice(0, range.from) + 'long hair' + range.suffix + text.slice(range.to)).toBe(expected)
    }
    expect(getImageTagRange('1girl | ', 8)).toBeNull()
    expect(getImageTagRange('{{char}}', 6)).toBeNull()
})

it('keeps Korean search results visible and exposes their descriptions and category', async () => {
    const search = vi.fn(async () => [
        { name: 'hatsune miku', category: 4, count: 100, description: '하츠네 미쿠' },
        { name: 'meta:novel era', category: 5, count: 0, description: '시대' },
    ])
    const status = vi.fn()
    const state = EditorState.create({ doc: '1girl, 미쿠' })
    const source = createImageTagCompletionSource({ search, onStatus: status })
    const result = await source(new CompletionContext(state, state.doc.length, false))
    expect(search).toHaveBeenCalledWith('미쿠', expect.any(AbortSignal))
    expect(result).toMatchObject({ from: 7, to: 9, filter: false })
    expect(result!.options[0]).toMatchObject({
        label: 'hatsune miku', apply: 'hatsune miku, ', detail: 'Character · 100', description: '하츠네 미쿠',
    })
    expect(result!.options[1].detail).toBe('Meta')
    expect(status).toHaveBeenLastCalledWith('idle')
    expect(status).not.toHaveBeenCalledWith('loading')
})

it('completes a weighted local bundle reference without requesting Danbooru tags', async () => {
    const search = vi.fn()
    const source = createImageTagCompletionSource({
        search,
        getBundles: () => [{ name: 'Miku', content: 'boy, black hair', source: 'Hatsune Miku' }],
    })
    const doc = '{{{### Mik}}}, outdoors'
    const cursor = doc.indexOf('Mik') + 3
    const state = EditorState.create({ doc })
    const result = await source(new CompletionContext(state, cursor, false))
    expect(result!.options[0]).toMatchObject({
        label: '### Miku', detail: 'Hatsune Miku', description: 'boy, black hair',
    })
    expect(doc.slice(0, result!.from) + result!.options[0].apply + doc.slice(result!.to!)).toBe('{{{### Miku}}}, outdoors')
    expect(search).not.toHaveBeenCalled()
})

it('reports a failed search without throwing or changing the prompt', async () => {
    const status = vi.fn()
    const state = EditorState.create({ doc: '장발' })
    const source = createImageTagCompletionSource({
        search: async () => { throw new Error('offline') }, onStatus: status,
    })
    expect(await source(new CompletionContext(state, 2, false))).toBeNull()
    expect(status.mock.calls.map(([value]) => value)).toEqual(['idle', 'error'])
    expect(state.doc.toString()).toBe('장발')
})

it('includes the selected composing syllable but skips ordinary selected text', async () => {
    const search = vi.fn(async () => [{ name: 'long hair', category: 0, count: 100, description: '장발' }])
    const state = EditorState.create({ doc: '1.3::장발', selection: { anchor: 6, head: 7 } })
    const source = createImageTagCompletionSource({ search })
    expect(await source(new CompletionContext(state, 6, false))).toBeNull()
    expect(search).not.toHaveBeenCalled()

    const view = { compositionStarted: true } as EditorView
    const result = await source(new CompletionContext(state, 6, false, view))
    expect(search).toHaveBeenCalledWith('장발', expect.any(AbortSignal))
    expect(result).toMatchObject({ from: 5, to: 7 })
})

it('returns no completion or loading flash for a fast search with no matches', async () => {
    const status = vi.fn()
    const state = EditorState.create({ doc: 'unmatched phrase' })
    const source = createImageTagCompletionSource({ search: async () => [], onStatus: status })
    expect(await source(new CompletionContext(state, state.doc.length, false))).toBeNull()
    expect(status).toHaveBeenLastCalledWith('idle')
    expect(status).not.toHaveBeenCalledWith('loading')
})
