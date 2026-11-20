import { describe, test, expect, vi } from 'vitest'
import { preparePatchConflictRebase } from './patchRebase'

// Isolate patch generation from database startup and storage side effects.
vi.mock('./database.svelte', () => ({}))
vi.mock('./autoStorage', () => ({ forageStorage: { realStorage: null } }))

const { normalizeJSON, RisuSavePatcher, decodeRisuSave, encodeRisuSaveLegacy } = await import('./risuSave')
const { applyPatch } = await import('fast-json-patch')

test('imports a backup selection by ID and keeps the internal save ID-based after reorder', async () => {
    const imported = await decodeRisuSave(encodeRisuSaveLegacy({
        characters: [],
        botPresets: [{ id: 'first', name: 'First' }, { id: 'second', name: 'Second' }],
        botPresetsId: 1,
    }))
    expect(imported.activePromptPresetId).toBe('second')
    expect(imported).not.toHaveProperty('botPresetsId')

    imported.botPresets.reverse()
    const restored = await decodeRisuSave(encodeRisuSaveLegacy(imported))
    expect(restored.activePromptPresetId).toBe('second')
    expect(restored.botPresets.map(preset => preset.id)).toEqual(['second', 'first'])
    expect(restored).not.toHaveProperty('botPresetsId')
})

test('retries an acknowledged chat insertion from the exact saved baseline without duplicates', async () => {
    const old = { id: 'old', name: 'Old', _stub: true }
    const added = { id: 'new', name: 'New', _stub: true }
    const base = { characters: [{ chaId: 'character', chats: [old] }], modules: [], botPresets: [] }
    const local = { ...base, characters: [{ chaId: 'character', chats: [added, old] }] }
    const server = { ...base, characters: [{ chaId: 'character', chats: [old, added] }] }
    const patcher = new RisuSavePatcher()
    await patcher.init(base)
    const accepted = patcher.getBaselineSnapshot()
    const rejected = await patcher.set(local, { ...emptyToSave(), character: ['character'] })
    expect(accepted.characters[0].chats).toEqual([old])

    const { mergedValue, serverBaseline } = preparePatchConflictRebase(server, {
        patch: rejected.patch, baseline: accepted,
    })
    expect(mergedValue).toEqual(local)
    await patcher.init(serverBaseline)
    const retry = await patcher.set(mergedValue, { ...emptyToSave(), character: ['character'] })
    expect(applyPatch(structuredClone(server), retry.patch, true).newDocument).toEqual(local)
})

const emptyToSave = () => ({
    character: [],
    chat: [] as [string, string][],
    root: false,
    botPreset: false,
    modules: false,
    plugins: false,
    pluginCustomStorage: false,
})

describe('RisuSavePatcher.set — server-owned generation metadata', () => {
    test('does not emit root or character ops when only server-owned values change locally', async () => {
        const initial = {
            statics: { messages: 4, imports: 1 },
            characters: [{
                chaId: 'character-1',
                name: 'Name',
                lastInteraction: 100,
                chats: [],
            }],
            botPresets: [],
            modules: [],
        }
        const patcher = new RisuSavePatcher()
        await patcher.init(initial)

        const { patch } = await patcher.set({
            ...initial,
            statics: { ...initial.statics, messages: 999 },
            characters: [{
                ...initial.characters[0],
                lastInteraction: 999,
            }],
        }, {
            ...emptyToSave(),
            root: true,
            character: ['character-1'],
        })

        expect(patch).toEqual([])
    })

    test('still emits client-owned edits beside server-owned values', async () => {
        const initial = {
            statics: { messages: 4, imports: 1 },
            characters: [{
                chaId: 'character-1',
                name: 'Old',
                lastInteraction: 100,
                chats: [],
            }],
            botPresets: [],
            modules: [],
        }
        const patcher = new RisuSavePatcher()
        await patcher.init(initial)

        const { patch } = await patcher.set({
            ...initial,
            statics: { messages: 999, imports: 2 },
            characters: [{
                ...initial.characters[0],
                name: 'New',
                lastInteraction: 999,
            }],
        }, {
            ...emptyToSave(),
            root: true,
            character: ['character-1'],
        })

        expect(patch).toContainEqual({
            op: 'replace',
            path: '/statics/imports',
            value: 2,
        })
        expect(patch).toContainEqual({
            op: 'replace',
            path: '/characters/0/name',
            value: 'New',
        })
        expect(patch.some((operation: any) =>
            operation.path.includes('messages')
            || operation.path.includes('lastInteraction')),
        ).toBe(false)
    })
})

function applyOpsTo(baseline: any, ops: any[]) {
    const copy = JSON.parse(JSON.stringify(baseline))
    applyPatch(copy, ops)
    return copy
}

async function runRoundTrip(
    initial: any,
    next: any,
    toSave: any,
) {
    const patcher = new RisuSavePatcher()
    await patcher.init(initial)
    const { patch } = await patcher.set(next, toSave)
    const serverBaseline = normalizeJSON(initial)
    const afterApply = applyOpsTo(serverBaseline, patch)
    const expected = normalizeJSON(next)
    return { patch, afterApply, expected }
}

describe('round-trip — patcher ops reconstruct the new state on a baseline', () => {
    test('modules: reorder preserves all data', async () => {
        const modules = [
            { id: 'a', name: 'A', lorebook: [{ key: 'k1', content: 'v1' }] },
            { id: 'b', name: 'B', lorebook: [{ key: 'k2', content: 'v2' }] },
            { id: 'c', name: 'C', lorebook: [{ key: 'k3', content: 'v3' }] },
        ]
        const initial = { characters: [], botPresets: [], modules }
        const next = { characters: [], botPresets: [], modules: [modules[2], modules[0], modules[1]] }
        const { afterApply, expected } = await runRoundTrip(initial, next, { ...emptyToSave(), modules: true })
        expect(afterApply.modules).toEqual(expected.modules)
    })

    test('modules: multi-level changes (add + edit at once)', async () => {
        const initial = {
            characters: [], botPresets: [],
            modules: [
                { id: 'a', name: 'A', description: 'v1' },
                { id: 'b', name: 'B', description: 'v1' },
            ],
        }
        const next = {
            characters: [], botPresets: [],
            modules: [
                { id: 'a', name: 'A', description: 'v2' },
                { id: 'b', name: 'B', description: 'v1' },
                { id: 'c', name: 'C', description: 'new' },
            ],
        }
        const { afterApply, expected } = await runRoundTrip(initial, next, { ...emptyToSave(), modules: true })
        expect(afterApply.modules).toEqual(expected.modules)
    })

    test('modules: deleting one preserves the remaining data', async () => {
        const modules = ['a', 'b', 'c'].map(id => ({
            id, name: id.toUpperCase(), lorebook: [{ key: `k-${id}`, content: `v-${id}` }],
        }))
        const initial = { characters: [], botPresets: [], modules }
        const next = { characters: [], botPresets: [], modules: modules.slice(1) }
        const { afterApply, expected } = await runRoundTrip(initial, next, { ...emptyToSave(), modules: true })
        expect(afterApply.modules).toEqual(expected.modules)
    })

    test('botPresets: delete from middle', async () => {
        const p = (name: string, temp = 80) => ({ id: name, name, temperature: temp, mainPrompt: 'You are...' })
        const initial = { characters: [], botPresets: [p('p1'), p('p2'), p('p3')], modules: [] }
        const next = { characters: [], botPresets: [p('p1'), p('p3')], modules: [] }
        const { afterApply, expected } = await runRoundTrip(initial, next, { ...emptyToSave(), botPreset: true })
        expect(afterApply.botPresets).toEqual(expected.botPresets)
    })

    test('botPresets: edit one (length unchanged)', async () => {
        const p = (name: string, temp = 80) => ({ id: name, name, temperature: temp, mainPrompt: 'You are...' })
        const initial = { characters: [], botPresets: [p('p1', 70), p('p2', 80)], modules: [] }
        const next = { characters: [], botPresets: [p('p1', 70), p('p2', 90)], modules: [] }
        const { patch, afterApply, expected } = await runRoundTrip(initial, next, { ...emptyToSave(), botPreset: true })
        expect(afterApply.botPresets).toEqual(expected.botPresets)
        expect(patch.length).toBeGreaterThan(0)
        expect(patch.every(op => op.path.startsWith('/botPresets/1/'))).toBe(true)
    })

    test.each([
        { name: 'missing', changed: { name: 'Changed' } },
        { name: 'duplicate', changed: { id: 'a', name: 'Changed' } },
    ])('botPresets: $name ids still reconstruct correctly', async ({ changed }) => {
        const first = { id: 'a', name: 'First' }
        const initial = { characters: [], modules: [], botPresets: [first, { id: 'b', name: 'Second' }] }
        const next = { ...initial, botPresets: [first, changed] }
        const { afterApply, expected } = await runRoundTrip(initial, next, { ...emptyToSave(), botPreset: true })
        expect(afterApply).toEqual(expected)
    })

    test('combined: edit modules and botPresets in a single save', async () => {
        const p = (name: string) => ({ id: name, name, temperature: 80, mainPrompt: 'You are...' })
        const initial = {
            characters: [],
            botPresets: [p('p1'), p('p2')],
            modules: [{ id: 'a', name: 'A', description: 'old' }],
        }
        const next = {
            characters: [],
            botPresets: [p('p1'), p('p3')],
            modules: [
                { id: 'a', name: 'A', description: 'new' },
                { id: 'b', name: 'B', description: 'added' },
            ],
        }
        const { afterApply, expected } = await runRoundTrip(initial, next, {
            ...emptyToSave(), modules: true, botPreset: true,
        })
        expect(afterApply.modules).toEqual(expected.modules)
        expect(afterApply.botPresets).toEqual(expected.botPresets)
    })

    test('modules: duplicate ids still reconstruct correctly', async () => {
        const initial = {
            characters: [], botPresets: [],
            modules: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }],
        }
        const next = {
            characters: [], botPresets: [],
            modules: [{ id: 'a', name: 'A' }, { id: 'a', name: 'A-duplicate' }],
        }
        const { afterApply, expected } = await runRoundTrip(initial, next, { ...emptyToSave(), modules: true })
        expect(afterApply.modules).toEqual(expected.modules)
    })

})

const chr = (chaId: string, fields: Record<string, any> = {}) => ({
    chaId,
    name: chaId.toUpperCase(),
    desc: '',
    firstMessage: '',
    chats: [{ id: 'chat-' + chaId, name: 'c', _stub: true }],
    ...fields,
})
const dbWith = (characters: any[], rest: Record<string, any> = {}) => ({
    formatversion: 4, username: 'u', personaPrompt: 'p', botPresets: [], modules: [], characters, ...rest,
})
const clone = (o: any) => JSON.parse(JSON.stringify(o))

describe('fast-path — no-op detection after each transition', () => {
    test('init → identical save is a no-op', async () => {
        const db = dbWith([chr('a'), chr('b')])
        const p = new RisuSavePatcher()
        await p.init(db)
        const { patch } = await p.set(clone(db), emptyToSave())
        expect(patch).toEqual([])
    })

    test('character field change → saved, then no-op (caught even with empty toSave.character)', async () => {
        const db = dbWith([chr('a'), chr('b')])
        const p = new RisuSavePatcher()
        await p.init(db)

        const changed = clone(db); changed.characters[1].desc = 'edited B'
        // Save-tracker hints can be absent; real edits must still be detected.
        const r1 = await p.set(clone(changed), emptyToSave())
        expect(r1.patch.some((o: any) => o.path === '/characters/1/desc')).toBe(true)

        const r2 = await p.set(clone(changed), emptyToSave())
        expect(r2.patch).toEqual([])
    })

    test('character delete → saved, then no-op', async () => {
        const db = dbWith([chr('a'), chr('b'), chr('c')])
        const p = new RisuSavePatcher()
        await p.init(db)

        const changed = clone(db); changed.characters.splice(1, 1) // remove b
        const r1 = await p.set(clone(changed), emptyToSave())
        expect(r1.patch.some((o: any) => o.path === '/characters')).toBe(true)

        const r2 = await p.set(clone(changed), emptyToSave())
        expect(r2.patch).toEqual([])
    })

    test('character reorder → saved, then no-op', async () => {
        const db = dbWith([chr('a'), chr('b'), chr('c')])
        const p = new RisuSavePatcher()
        await p.init(db)

        const changed = clone(db); changed.characters = [changed.characters[2], changed.characters[0], changed.characters[1]]
        const r1 = await p.set(clone(changed), emptyToSave())
        expect(r1.patch.some((o: any) => o.path === '/characters')).toBe(true)

        const r2 = await p.set(clone(changed), emptyToSave())
        expect(r2.patch).toEqual([])
    })
})

describe('fast-path — a skipped block still catches a later change', () => {
    test('no-op save (fast-path skip) does not blind the patcher to the next edit', async () => {
        const db = dbWith([chr('a'), chr('b')])
        const p = new RisuSavePatcher()
        await p.init(db)

        expect((await p.set(clone(db), emptyToSave())).patch).toEqual([])

        const edited = clone(db); edited.characters[0].firstMessage = 'hi'
        const { patch } = await p.set(clone(edited), emptyToSave())
        expect(patch.some((o: any) => o.path === '/characters/0/firstMessage')).toBe(true)
    })

    test('root no-op then root edit is caught', async () => {
        const db = dbWith([chr('a')])
        const p = new RisuSavePatcher()
        await p.init(db)
        expect((await p.set(clone(db), emptyToSave())).patch).toEqual([])

        const edited = clone(db); edited.username = 'renamed'
        const { patch } = await p.set(clone(edited), emptyToSave())
        expect(patch.some((o: any) => o.path === '/username')).toBe(true)
    })
})

describe('fast-path — shared (non-cyclic) references round-trip correctly', () => {
    test('character with a shared ref: round-trips without null corruption, then no-op', async () => {
        const shared = { tag: 'v', n: 1 }
        const base = dbWith([chr('a')])
        const p = new RisuSavePatcher()
        await p.init(base)

        const withShared = dbWith([chr('a', { extA: shared, extB: shared })])
        const { patch } = await p.set(withShared, { ...emptyToSave(), character: ['a'] })

        const server = JSON.parse(JSON.stringify(normalizeJSON(base)))
        applyPatch(server, patch)
        expect(server.characters[0].extA).toEqual({ tag: 'v', n: 1 })
        expect(server.characters[0].extB).toEqual({ tag: 'v', n: 1 })

        expect((await p.set(withShared, emptyToSave())).patch).toEqual([])
    })

    test('a real content change under a shared ref is still caught', async () => {
        const shared = { tag: 'v', n: 1 }
        const p = new RisuSavePatcher()
        await p.init(dbWith([chr('a', { extA: shared, extB: shared })]))

        const changed = dbWith([chr('a', { extA: { tag: 'v', n: 1 }, extB: { tag: 'v', n: 2 } })])
        const { patch } = await p.set(changed, emptyToSave())
        expect(patch.some((o: any) => o.path.startsWith('/characters/0/extB'))).toBe(true)
    })

    test('root-level shared ref round-trips and converges to a no-op', async () => {
        const shared = { theme: 'x' }
        const base = dbWith([chr('a')])
        const p = new RisuSavePatcher()
        await p.init(base)

        const withShared = dbWith([chr('a')], { sdProvider: shared, customCss: shared } as any)
        const { patch } = await p.set(withShared, { ...emptyToSave(), root: true })
        const server = JSON.parse(JSON.stringify(normalizeJSON(base)))
        applyPatch(server, patch)
        expect(server.sdProvider).toEqual({ theme: 'x' })
        expect(server.customCss).toEqual({ theme: 'x' })

        expect((await p.set(withShared, emptyToSave())).patch).toEqual([])
    })
})

describe('fast-path — hash stays consistent with a fresh init', () => {
    test('hash after N mutating saves equals a fresh init of the same data', async () => {
        const db = dbWith([chr('a'), chr('b')])
        const live = new RisuSavePatcher()
        await live.init(db)

        const s1 = clone(db); s1.personaPrompt = 'x'; await live.set(clone(s1), { ...emptyToSave(), root: true })
        const s2 = clone(s1); s2.characters[0].desc = 'y'; await live.set(clone(s2), emptyToSave())
        const s3 = clone(s2); s3.characters.push(chr('c')); await live.set(clone(s3), emptyToSave())
        const s4 = clone(s3); s4.characters.splice(0, 1); await live.set(clone(s4), emptyToSave())

        const liveHash = live.hash()

        const fresh = new RisuSavePatcher()
        await fresh.init(clone(s4))
        const freshHash = fresh.hash()

        expect(liveHash).toBe(freshHash)
    })
})

describe('fast-path — per-root-key granularity', () => {
    test('personaPrompt edit emits ONLY /personaPrompt ops (other root keys untouched)', async () => {
        const db = dbWith([chr('a')], { customCSS: 'body{}'.repeat(100), loreBook: [{ key: 'x', content: 'y' }] } as any)
        const p = new RisuSavePatcher()
        await p.init(db)

        const changed = clone(db); changed.personaPrompt = 'edited'
        const { patch } = await p.set(clone(changed), { ...emptyToSave(), root: true })
        expect(patch.length).toBeGreaterThan(0)
        for (const op of patch) {
            expect(op.path.startsWith('/personaPrompt')).toBe(true)
        }

        const r2 = await p.set(clone(changed), emptyToSave())
        expect(r2.patch).toEqual([])
    })

    test('root key added → add op; root key deleted → remove op; then no-op', async () => {
        const db = dbWith([chr('a')])
        const p = new RisuSavePatcher()
        await p.init(db)

        const added = clone(db); added.newSetting = { on: true }
        const r1 = await p.set(clone(added), { ...emptyToSave(), root: true })
        expect(r1.patch.some((o: any) => o.op === 'add' && o.path === '/newSetting')).toBe(true)
        expect((await p.set(clone(added), emptyToSave())).patch).toEqual([])

        const removed = clone(added); delete removed.newSetting
        const r2 = await p.set(clone(removed), { ...emptyToSave(), root: true })
        expect(r2.patch.some((o: any) => o.op === 'remove' && o.path === '/newSetting')).toBe(true)
        expect((await p.set(clone(removed), emptyToSave())).patch).toEqual([])
    })

    test('an own __proto__ root key never produces a forbidden patch op', async () => {
        // JSON can contain an own __proto__ key, which the server rejects in patches.
        const db: any = dbWith([chr('a')])
        Object.defineProperty(db, '__proto__', { value: { polluted: true }, enumerable: true, writable: true, configurable: true })
        expect(Object.keys(db)).toContain('__proto__')

        const p = new RisuSavePatcher()
        await p.init(db)
        const changed = clone(db); changed.personaPrompt = 'edited'
        const { patch } = await p.set(clone(changed), { ...emptyToSave(), root: true })

        expect(patch.some((o: any) => o.path === '/__proto__' || o.path.startsWith('/__proto__/'))).toBe(false)
        expect(patch.some((o: any) => o.path === '/personaPrompt')).toBe(true)
        const serverState = JSON.parse(JSON.stringify(normalizeJSON(db)))
        expect(() => applyPatch(serverState, patch)).not.toThrow()
        expect((await p.set(clone(changed), emptyToSave())).patch).toEqual([])
    })

    test('a root value with toJSON()→undefined is kept, not removed', async () => {
        // Persistence ignores toJSON; raw JSON.stringify must not decide key presence.
        const db: any = dbWith([chr('a')])
        db.weird = { x: 1, toJSON() { return undefined } }
        const p = new RisuSavePatcher()
        await p.init(db)

        const { patch } = await p.set(db, { ...emptyToSave(), root: true })
        expect(patch).toEqual([])

        const liveHash = p.hash()
        const fresh = new RisuSavePatcher(); await fresh.init(db)
        expect(liveHash).toBe(fresh.hash())
    })

    test('a top-level bigint root value drops cleanly — no undefined baseline / hash stays consistent', async () => {
        // Unsupported values must be omitted consistently from the baseline and hash.
        const db: any = dbWith([chr('a')])
        db.bsig = 123n
        const p = new RisuSavePatcher()
        await p.init(db)
        await p.set(db, { ...emptyToSave(), root: true })

        const liveHash = p.hash()
        const fresh = new RisuSavePatcher(); await fresh.init(db)
        const freshHash = fresh.hash()
        expect(liveHash).toBe(freshHash)
    })

    test('per-key ops reconstruct the same server state as a whole-root diff would', async () => {
        const db = dbWith([chr('a')], { sdProvider: { x: 1 }, themeList: ['a', 'b'] } as any)
        const p = new RisuSavePatcher()
        await p.init(db)

        const changed = clone(db)
        changed.personaPrompt = 'new'
        changed.sdProvider = { x: 2, y: 3 }
        delete changed.themeList
        const { patch } = await p.set(clone(changed), { ...emptyToSave(), root: true })

        const serverState = JSON.parse(JSON.stringify(normalizeJSON(db)))
        applyPatch(serverState, patch)
        expect(serverState).toEqual(normalizeJSON(clone(changed)))
    })
})

describe('fast-path — per-module granularity', () => {
    const mod = (id: string, content = '') => ({
        id, name: 'M' + id, lorebook: [{ key: 'k', comment: 'c', content }], regex: [], trigger: [],
    })

    test('editing one module emits ops only under that module index; then no-op', async () => {
        const db = dbWith([chr('a')], { } as any)
        db.modules = [mod('m1', 'aaa'), mod('m2', 'bbb'), mod('m3', 'ccc')]
        const p = new RisuSavePatcher()
        await p.init(db)

        const changed = clone(db); changed.modules[1].lorebook[0].content = 'edited'
        const { patch } = await p.set(clone(changed), { ...emptyToSave(), modules: true })
        expect(patch.length).toBeGreaterThan(0)
        for (const op of patch) {
            expect(op.path.startsWith('/modules/1')).toBe(true)
        }

        const r2 = await p.set(clone(changed), { ...emptyToSave(), modules: true })
        expect(r2.patch).toEqual([])
    })

    test('modules hash from cached item hashes equals a fresh full hash', async () => {
        const db = dbWith([chr('a')], { } as any)
        db.modules = [mod('m1', 'aaa'), mod('m2', 'bbb')]
        const live = new RisuSavePatcher()
        await live.init(db)

        const s1 = clone(db); s1.modules[0].lorebook[0].content = 'x1'
        await live.set(clone(s1), { ...emptyToSave(), modules: true })
        const s2 = clone(s1); s2.modules[1].name = 'renamed'
        await live.set(clone(s2), { ...emptyToSave(), modules: true })

        const liveHash = live.hash()
        const fresh = new RisuSavePatcher()
        await fresh.init(clone(s2))
        const freshHash = fresh.hash()
        expect(liveHash).toBe(freshHash)
    })

    test('module id "__proto__" cannot poison the caches — hash stays consistent', async () => {
        // IDs are user data and may match object prototype keys.
        const db = dbWith([chr('a')], { } as any)
        db.modules = [mod('__proto__', 'aaa'), mod('m2', 'bbb')]
        const live = new RisuSavePatcher()
        await live.init(db)

        const s1 = clone(db); s1.modules[0].lorebook[0].content = 'edited'
        const r1 = await live.set(clone(s1), { ...emptyToSave(), modules: true })
        expect(r1.patch.some((o: any) => o.path.startsWith('/modules/0'))).toBe(true)
        expect((await live.set(clone(s1), { ...emptyToSave(), modules: true })).patch).toEqual([])

        const liveHash = live.hash()
        const fresh = new RisuSavePatcher()
        await fresh.init(clone(s1))
        const freshHash = fresh.hash()
        expect(liveHash).toBe(freshHash)
    })

    test('non-string module ids (1 vs "1") force the structural path — no key collision', async () => {
        const db = dbWith([chr('a')], { } as any)
        db.modules = [{ ...mod('x'), id: 1 as any }, { ...mod('y'), id: '1' }]
        const live = new RisuSavePatcher()
        await live.init(db)

        const s1 = clone(db); s1.modules[0].lorebook[0].content = 'edited'
        const r1 = await live.set(clone(s1), { ...emptyToSave(), modules: true })
        expect(r1.patch.length).toBe(1)
        expect(r1.patch[0].path).toBe('/modules')

        const liveHash = live.hash()
        const fresh = new RisuSavePatcher()
        await fresh.init(clone(s1))
        const freshHash = fresh.hash()
        expect(liveHash).toBe(freshHash)
    })
})
