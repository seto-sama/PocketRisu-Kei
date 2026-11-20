import { describe, test, expect } from 'vitest'
import { findChatInternalFieldOps } from '../../../shared/chatShape.mjs'

// The server rejects these patches and the client refuses to send them; both
// sides share this one rule: chat paths may touch list metadata only.
describe('findChatInternalFieldOps', () => {
    test('passes ops outside chats, whole-slot ops, and metadata fields', () => {
        expect(findChatInternalFieldOps([
            { op: 'replace', path: '/characters/0/customCSS', value: '...' },
            { op: 'replace', path: '/characters/0/chats', value: [] },
            { op: 'add', path: '/characters/0/chats/3', value: { id: 'x', name: 'y', _stub: true } },
            { op: 'remove', path: '/characters/0/chats/2' },
            { op: 'replace', path: '/characters/0/chats/0/name', value: 'renamed' },
            { op: 'remove', path: '/characters/0/chats/0/folderId' },
            { op: 'move', from: '/characters/0/chats/0/lastDate', path: '/characters/0/chats/1/lastDate' },
            { op: 'remove', path: '/characters/abc/chats/0/message' },
        ])).toEqual([])
        expect(findChatInternalFieldOps(null as any)).toEqual([])
        expect(findChatInternalFieldOps([null, 'string', { op: 'replace' }] as any)).toEqual([])
    })

    test('rejects body and runtime fields, including nested and _stub paths', () => {
        const violations = findChatInternalFieldOps([
            { op: 'add', path: '/characters/12/chats/0/message/0', value: { role: 'user' } },
            { op: 'replace', path: '/characters/0/chats/0/note', value: 'x' },
            { op: 'remove', path: '/characters/0/chats/0/_stub' },
            { op: 'add', path: '/characters/0/chats/0/_stub', value: true },
        ])
        expect(violations.map(v => v.field)).toEqual(['message', 'note', '_stub', '_stub'])
        expect(violations[0].path).toBe('/characters/12/chats/0/message/0')
    })

    test('rejects move/copy whose source is a non-metadata chat field', () => {
        expect(findChatInternalFieldOps([
            { op: 'copy', from: '/characters/0/chats/0/message', path: '/foo' },
            { op: 'move', from: '/characters/0/chats/0/_stub', path: '/characters/0/chats/0/name' },
        ]).map(v => v.field)).toEqual(['message', '_stub'])
    })
})
