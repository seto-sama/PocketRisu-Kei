import { describe, expect, it, vi } from 'vitest'
vi.mock('./database.svelte', () => ({}))
vi.mock('./chatStorage', () => ({ chatToStub: (chat: unknown) => chat }))
vi.mock('./autoStorage', () => ({ forageStorage: { realStorage: null } }))
const { calculateHash, RisuSavePatcher } = await import('./risuSave')
import { createPatchHashDiagnostics, comparePatchHashDiagnostics, isPatchHashDiagnostics } from '../../../shared/patchHashDiagnostics.mjs'

const character = (chaId: string, name = chaId) => ({ chaId, name, chats: [] })
const diagnose = (database: unknown) => createPatchHashDiagnostics(database, calculateHash)

describe('patch hash mismatch diagnostics', () => {
    it('separates reorders, edits, additions and deletions by identity without logging values', () => {
        const local = { language: 'ko', removed: true, characters: [character('a'), character('b'), character('gone')] }
        const server = { language: 'en', added: true, characters: [character('b', 'secret name'), character('a'), character('new')] }
        const diff = comparePatchHashDiagnostics(diagnose(local), diagnose(server))
        expect(diff.keys.map(row => row.key)).toEqual(['language', 'removed', 'characters', 'added'])
        expect(diff.characters).toEqual(expect.arrayContaining([
            expect.objectContaining({ id: 'a', localIndex: 0, serverIndex: 1, local: calculateHash(local.characters[0]).toString(16) }),
            expect.objectContaining({ id: 'b', localIndex: 1, serverIndex: 0 }),
            expect.objectContaining({ id: 'gone', server: null }),
            expect.objectContaining({ id: 'new', local: null }),
        ]))
        expect(diff.characters.find(row => row.id === 'a')!.local).toBe(diff.characters.find(row => row.id === 'a')!.server)
        expect(JSON.stringify(diff)).not.toContain('secret name')
    })

    it('retains duplicate, missing and prototype-like ids without overwriting entries', () => {
        const local = JSON.parse('{"__proto__":1,"constructor":2,"characters":[]}')
        local.characters = [character('__proto__'), character('a'), character('a'), { chats: [] }, character('#0')]
        const server = structuredClone(local)
        delete server.constructor
        server.characters[2].name = 'changed'
        server.characters[3].name = 'missing id'
        const diff = comparePatchHashDiagnostics(diagnose(local), diagnose(server))
        expect(diff.keys).toContainEqual({ key: 'constructor', local: calculateHash(2).toString(16), server: null })
        expect(diff.characters.map(row => [row.id, row.occurrence])).toEqual([['a', 1], [null, 0]])
        expect(comparePatchHashDiagnostics(diagnose(local), diagnose(local))).toEqual({ keys: [], characters: [] })
        expect(isPatchHashDiagnostics({ keys: {}, characters: [null] })).toBe(false)
    })

    it('compares the accepted pre-image even after patch construction advances its baseline', async () => {
        const local = { language: 'ko', characters: [character('a')], botPresets: [], modules: [] }
        const patcher = new RisuSavePatcher()
        await patcher.init(local)
        const accepted = patcher.getBaselineSnapshot()
        await patcher.set({ ...local, language: 'en' } as any, { root: true, character: [], chat: [], botPreset: false, modules: false, plugins: false, pluginCustomStorage: false })
        expect(patcher.getBaselineSnapshot().language).toBe('en')
        expect(comparePatchHashDiagnostics(diagnose(accepted), diagnose(accepted)).keys).toEqual([])
        expect(comparePatchHashDiagnostics(diagnose(patcher.getBaselineSnapshot()), diagnose(accepted)).keys.map(row => row.key)).toContain('language')
    })
})
