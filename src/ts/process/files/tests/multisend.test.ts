import { Buffer } from 'buffer'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { state } = vi.hoisted(() => ({
    state: {
        database: { characters: [{ chats: [{ message: [] as unknown[] }] }] },
        addedTexts: [] as unknown[],
        addTextGate: Promise.resolve(),
        indexReady: false,
        matches: [] as string[],
        downloadFile: vi.fn(),
    },
}))

vi.mock('src/ts/storage/database.svelte', () => ({
    getDatabase: () => state.database,
    setDatabase: vi.fn(),
}))

vi.mock('src/ts/stores.svelte', () => ({
    selectedCharID: {
        subscribe(run: (value: number) => void) {
            run(0)
            return () => {}
        },
    },
}))

vi.mock('src/ts/globalApi.svelte', () => ({ downloadFile: state.downloadFile }))

vi.mock('src/ts/process/memory/hypamemory', () => ({
    HypaProcesser: class {
        async addText(texts: unknown[]) {
            state.addedTexts = [...texts]
            await state.addTextGate
            state.indexReady = true
        }

        async similaritySearch() {
            if (!state.indexReady) throw new Error('Search started before indexing finished')
            return state.matches
        }
    },
}))

vi.mock('src/ts/process/index.svelte', () => ({
    doingChat: { set: vi.fn() },
    sendChat: vi.fn(),
}))

vi.mock('src/ts/process/files/inlays', () => ({ postInlayAsset: vi.fn() }))

vi.mock('src/ts/util', () => ({
    BufferToText: (data: Uint8Array) => new TextDecoder().decode(data),
    selectMultipleFile: vi.fn(),
}))

import { postChatFile } from '../multisend'

function deferred() {
    let resolve!: () => void
    const promise = new Promise<void>(done => { resolve = done })
    return { promise, resolve }
}

beforeEach(() => {
    state.database = { characters: [{ chats: [{ message: [] }] }] }
    state.addedTexts = []
    state.addTextGate = Promise.resolve()
    state.indexReady = false
    state.matches = Array.from({ length: 9 }, (_, index) => `match-${index + 1}`)
    state.downloadFile.mockReset().mockResolvedValue(undefined)
})

describe('postChatFile', () => {
    it.each([
        {
            name: 'context.txt',
            source: 'Opening line\nmatching detail\nClosing line',
            expectedTexts: ['Opening line', 'matching detail', 'Closing line'],
        },
        {
            name: 'context.xml',
            source: '<root><first>Alpha</first><second>Beta</second></root>',
            expectedTexts: ['AlphaBeta', 'Alpha', 'Beta'],
        },
    ])('waits for indexing and returns the matching context for $name', async ({ name, source, expectedTexts }) => {
        const gate = deferred()
        state.addTextGate = gate.promise

        const resultPromise = postChatFile({ name, data: new TextEncoder().encode(source) })
        const observedResult = resultPromise.then(
            value => ({ value }),
            error => ({ error }),
        )

        await vi.waitFor(() => expect(state.addedTexts).toEqual(expectedTexts))
        gate.resolve()

        const outcome = await observedResult
        if ('error' in outcome) throw outcome.error
        const [result] = outcome.value
        expect(result).toMatchObject({ type: 'text', name })
        expect(Buffer.from(result.type === 'text' ? result.data : '', 'base64').toString('utf8')).toBe(
            '<File>\n\nmatch-1\nmatch-2\nmatch-3\nmatch-4\nmatch-5\nmatch-6\nmatch-7\n</File>\n',
        )
    })

    it('keeps the final line when translating a long catalog without generated entries', async () => {
        const finalLine = '# final catalog comment'
        const source = ['# translated catalog', ...Array.from({ length: 105 }, (_, i) => `# comment ${i + 1}`), finalLine].join('\n')

        await postChatFile({ name: 'messages.po', data: new TextEncoder().encode(source) })

        const [filename, translated] = state.downloadFile.mock.lastCall ?? []
        expect(filename).toBe('translated.po')
        expect(translated).toContain(finalLine)
    })
})
