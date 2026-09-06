import { describe, expect, it } from 'vitest'
import { preparePatchConflictRebase } from './patchRebase'
import { compare } from 'fast-json-patch'

describe('patch conflict rebase', () => {
    it.each([
        { field: 'chats', key: 'id' },
        { field: 'characters', key: 'chaId' },
        { field: 'message', key: 'chatId' },
    ])('does not duplicate an acknowledged addition in $field', ({ field, key }) => {
        const old = { [key]: 'old', name: 'Old' }
        const added = { [key]: 'new', name: 'New' }
        const base = { [field]: [old] }
        const local = { [field]: [added, old] }
        // Content-first creation appends on the server, while the UI prepends.
        const server = { [field]: [old, added] }
        const patch = compare(base, local)
        const result = preparePatchConflictRebase(server, { patch, baseline: base })

        expect(result.mergedValue).toEqual(local)
        expect(result.serverBaseline).toEqual(server)
        expect(server[field]).toEqual([old, added])
        expect(preparePatchConflictRebase(result.mergedValue, { patch, baseline: base }).mergedValue)
            .toEqual(local)
    })

    it('matches nested edits and deletions by identity after server reordering', () => {
        const base = { characters: [{ chaId: 'a', chats: [
            { id: 'one', name: 'One', folderId: null },
            { id: 'two', name: 'Two', folderId: null },
        ] }] }
        const local = structuredClone(base)
        local.characters[0].chats[1].name = 'Renamed locally'
        local.characters[0].chats.shift()
        const server = { characters: [
            { chaId: 'concurrent', chats: [] },
            { chaId: 'a', chats: [
                { id: 'two', name: 'Two', folderId: 'server-folder' },
                { id: 'three', name: 'Server addition', folderId: null },
                base.characters[0].chats[0],
            ] },
        ] }

        const { mergedValue } = preparePatchConflictRebase(server, { patch: compare(base, local), baseline: base })
        expect(mergedValue.characters).toEqual([
            { chaId: 'concurrent', chats: [] },
            { chaId: 'a', chats: [
                { id: 'two', name: 'Renamed locally', folderId: 'server-folder' },
                { id: 'three', name: 'Server addition', folderId: null },
            ] },
        ])
    })

    it('preserves unrelated server settings and server deletions', () => {
        const base = { language: 'ko', settings: { local: 1, remote: 1 }, modules: [
            { id: 'deleted', name: 'Deleted on server' }, { id: 'kept', name: 'Kept' },
        ] }
        const local = structuredClone(base)
        local.settings.local = 2
        local.modules[1].name = 'Local edit'
        const server = { language: 'en', settings: { local: 1, remote: 2 }, modules: [base.modules[1]] }
        expect(preparePatchConflictRebase(server, { patch: compare(base, local), baseline: base }).mergedValue).toEqual({
            language: 'en', settings: { local: 2, remote: 2 },
            modules: [{ id: 'kept', name: 'Local edit' }],
        })
    })

    it('preserves another client\'s list order when only editing an item field', () => {
        const base = { modules: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }] }
        const local = { modules: [{ id: 'a', name: 'Edited' }, base.modules[1]] }
        const server = { modules: [base.modules[1], { id: 'c', name: 'Concurrent' }, base.modules[0]] }
        expect(preparePatchConflictRebase(server, { patch: compare(base, local), baseline: base }).mergedValue).toEqual({
            modules: [base.modules[1], { id: 'c', name: 'Concurrent' }, local.modules[0]],
        })
    })

    it('replays root replacements using the returned patch document', () => {
        expect(preparePatchConflictRebase({ old: true }, {
            baseline: { old: true },
            patch: [{ op: 'replace', path: '', value: { replacement: true } }],
        }).mergedValue).toEqual({ replacement: true })
    })

    it('preserves server field removal while applying a different local field edit', () => {
        const base = { settings: { removed: 'old', edited: 'old' } }
        const local = { settings: { removed: 'old', edited: 'local' } }
        const server = { settings: { edited: 'old' } }
        const { mergedValue } = preparePatchConflictRebase(server, {
            baseline: base, patch: compare(base, local),
        })
        expect(mergedValue).toEqual({ settings: { edited: 'local' } })
        expect(mergedValue.settings).not.toHaveProperty('removed')
    })

    it('keeps the server pre-image as the retry hash baseline', () => {
        const latestServer = {
            characters: [],
            botPresets: [],
            modules: [],
            personaPrompt: 'server',
        }
        const rejectedPatch = [{
            op: 'replace',
            path: '/personaPrompt',
            value: 'local',
        }]

        const { serverBaseline, mergedValue } = preparePatchConflictRebase(
            latestServer,
            { patch: rejectedPatch, baseline: latestServer },
        )

        expect(serverBaseline.personaPrompt).toBe('server')
        expect(mergedValue.personaPrompt).toBe('local')

        // Replaying must not mutate the object later installed as the patch
        // protocol baseline. The retry diff is server -> merged/local.
        expect(serverBaseline).toEqual(latestServer)
        expect(serverBaseline).not.toBe(latestServer)
        expect(mergedValue).not.toBe(serverBaseline)
    })
})
