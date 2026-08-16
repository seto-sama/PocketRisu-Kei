import { describe, test, expect, vi } from 'vitest'

// Mock heavy deps so importing risuSave.ts doesn't pull the Svelte runtime
// or trigger unrelated module-level side effects. findDangerousChatOps is a
// pure function with no runtime deps of its own.
vi.mock('./database.svelte', () => ({}))
vi.mock('./chatStorage', () => ({}))
vi.mock('./autoStorage', () => ({ forageStorage: { realStorage: null } }))

const { findDangerousChatOps } = await import('./risuSave')

// Op-matrix tests for the client-side patch guard. The server has an
// equivalent guard (findChatInternalFieldOps in server.cjs); both must
// agree on what counts as a chat-internal field op. If you change one,
// update the other and add the matching cases here.

describe('findDangerousChatOps — path matching', () => {
    test('passes ops outside the chats subtree', () => {
        expect(findDangerousChatOps([
            { op: 'replace', path: '/characters/0/customCSS', value: '...' },
            { op: 'add', path: '/modules/2', value: {} },
            { op: 'replace', path: '/lastModelSelected', value: 'gpt-4' },
        ])).toEqual([])
    })

    test('passes whole-chat ops (no field component in path)', () => {
        expect(findDangerousChatOps([
            { op: 'replace', path: '/characters/0/chats', value: [] },
            { op: 'add', path: '/characters/0/chats/3', value: { id: 'x', name: 'y', _stub: true } },
            { op: 'remove', path: '/characters/0/chats/2' },
        ])).toEqual([])
    })

    test('passes ops on allowed stub metadata fields', () => {
        expect(findDangerousChatOps([
            { op: 'replace', path: '/characters/0/chats/0/name', value: 'renamed' },
            { op: 'add', path: '/characters/0/chats/0/folderId', value: 'F1' },
            { op: 'remove', path: '/characters/0/chats/0/folderId' },
            { op: 'replace', path: '/characters/0/chats/0/lastDate', value: 12345 },
            { op: 'add', path: '/characters/0/chats/0/modules', value: ['m'] },
            { op: 'replace', path: '/characters/0/chats/0/id', value: 'new-id' },
        ])).toEqual([])
    })

    test('handles non-array / malformed input safely', () => {
        expect(findDangerousChatOps(null as any)).toEqual([])
        expect(findDangerousChatOps(undefined as any)).toEqual([])
        expect(findDangerousChatOps([null, undefined, 'string', 42] as any)).toEqual([])
        expect(findDangerousChatOps([{ op: 'replace' }] as any)).toEqual([])  // no path
    })
})

describe('findDangerousChatOps — non-stub field rejection', () => {
    test('rejects ops that touch chat payload fields', () => {
        const v = findDangerousChatOps([
            { op: 'remove', path: '/characters/0/chats/0/message' },
            { op: 'add', path: '/characters/0/chats/0/note', value: 'x' },
            { op: 'replace', path: '/characters/0/chats/0/localLore', value: [] },
            { op: 'remove', path: '/characters/0/chats/0/hypaV3Data' },
            { op: 'remove', path: '/characters/0/chats/0/supaMemory' },
            { op: 'remove', path: '/characters/0/chats/0/scriptstate' },
            { op: 'remove', path: '/characters/0/chats/0/bindedPersona' },
            { op: 'remove', path: '/characters/0/chats/0/fmIndex' },
        ])
        expect(v.length).toBe(8)
        expect(v.map(x => x.field)).toEqual([
            'message', 'note', 'localLore', 'hypaV3Data',
            'supaMemory', 'scriptstate', 'bindedPersona', 'fmIndex',
        ])
    })

    test('reports first field component for nested paths', () => {
        const v = findDangerousChatOps([
            { op: 'add', path: '/characters/0/chats/0/message/0', value: { role: 'user' } },
        ])
        expect(v).toHaveLength(1)
        expect(v[0].field).toBe('message')
    })
})

describe('findDangerousChatOps — _stub special handling', () => {
    test('rejects remove of _stub', () => {
        const v = findDangerousChatOps([
            { op: 'remove', path: '/characters/0/chats/0/_stub' },
        ])
        expect(v).toHaveLength(1)
        expect(v[0].reason).toBe('remove _stub')
    })

    test('rejects replace of _stub to a falsy value', () => {
        const v = findDangerousChatOps([
            { op: 'replace', path: '/characters/0/chats/0/_stub', value: false },
        ])
        expect(v).toHaveLength(1)
        expect(v[0].reason).toBe('non-true _stub value')
    })

    test('rejects add of _stub with non-true value', () => {
        const v = findDangerousChatOps([
            { op: 'add', path: '/characters/0/chats/0/_stub', value: 1 },
            { op: 'add', path: '/characters/0/chats/0/_stub', value: 'true' },
            { op: 'add', path: '/characters/0/chats/0/_stub', value: null },
        ])
        expect(v).toHaveLength(3)
        for (const x of v) expect(x.reason).toBe('non-true _stub value')
    })

    test('passes add/replace of _stub with literal true', () => {
        expect(findDangerousChatOps([
            { op: 'add', path: '/characters/0/chats/0/_stub', value: true },
            { op: 'replace', path: '/characters/0/chats/0/_stub', value: true },
        ])).toEqual([])
    })
})

describe('findDangerousChatOps — disallowed op types (move/copy/test)', () => {
    test('rejects move on a chat-internal field path', () => {
        const v = findDangerousChatOps([
            { op: 'move', from: '/foo', path: '/characters/0/chats/0/message' },
        ])
        expect(v).toHaveLength(1)
        expect(v[0].reason).toBe('disallowed op type on chat field')
    })

    test('rejects move whose `from` aliases _stub even if path is allowed', () => {
        // The bypass attempt: path is on an allowed field (name), but `from`
        // pulls _stub out of another chat slot. Field-name-only allowlist
        // would miss this.
        const v = findDangerousChatOps([
            { op: 'move', from: '/characters/0/chats/0/_stub', path: '/characters/0/chats/0/name' },
        ])
        expect(v).toHaveLength(1)
        expect(v[0].reason).toBe('disallowed op type on chat field')
    })

    test('rejects copy whose `from` is a chat-internal field', () => {
        const v = findDangerousChatOps([
            { op: 'copy', from: '/characters/0/chats/0/message', path: '/foo' },
        ])
        expect(v).toHaveLength(1)
        expect(v[0].reason).toBe('disallowed op type on chat field')
    })

    test('rejects test op on a chat field', () => {
        const v = findDangerousChatOps([
            { op: 'test', path: '/characters/0/chats/0/_stub', value: true },
        ])
        expect(v).toHaveLength(1)
        expect(v[0].reason).toBe('disallowed op type on chat field')
    })

    test('passes move/copy that doesn\'t touch chat-internal paths', () => {
        // move/copy are fine outside the chats subtree.
        expect(findDangerousChatOps([
            { op: 'move', from: '/modules/0', path: '/modules/2' },
            { op: 'copy', from: '/characters/0/customCSS', path: '/characters/1/customCSS' },
        ])).toEqual([])
    })
})

describe('findDangerousChatOps — character index parsing', () => {
    test('handles multi-digit indices', () => {
        const v = findDangerousChatOps([
            { op: 'remove', path: '/characters/123/chats/45/message' },
        ])
        expect(v).toHaveLength(1)
        expect(v[0].path).toBe('/characters/123/chats/45/message')
    })

    test('does not match malformed paths', () => {
        expect(findDangerousChatOps([
            { op: 'remove', path: '/characters/abc/chats/0/message' },     // non-numeric
            { op: 'remove', path: '/characters/0/chats/x/message' },       // non-numeric chat idx
            { op: 'remove', path: 'characters/0/chats/0/message' },        // no leading slash
            { op: 'remove', path: '/CHARACTERS/0/chats/0/message' },       // wrong case
        ])).toEqual([])
    })
})
