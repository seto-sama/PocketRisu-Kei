import { describe, test, expect, vi } from 'vitest'
import { preparePatchConflictRebase } from './patchRebase'

// Mock heavy deps so importing risuSave.ts doesn't pull the Svelte runtime
// or trigger module-level side effects. The patcher and the helper it
// delegates to are pure once `compare` is injected.
vi.mock('./database.svelte', () => ({}))
vi.mock('./chatStorage', () => ({
    // Identity stub — character path is exercised with empty `characters`
    // arrays in this suite, but the mock has to exist so import resolution
    // works.
    chatToStub: (c: any) => c,
}))
vi.mock('./autoStorage', () => ({ forageStorage: { realStorage: null } }))

const { diffArrayWithIdGuard, RisuSavePatcher } = await import('./risuSave')
const { compare } = await import('fast-json-patch')

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
    const { applyPatch } = await import('fast-json-patch')
    expect(applyPatch(structuredClone(server), retry.patch, true).newDocument).toEqual(local)
})

// ──────────────────────────────────────────────────────────────────────────
// diffArrayWithIdGuard — direct tests on the structural-vs-elementwise pivot.
//
// The bug this protects against: deleting an entry from the front of an
// array of deeply nested objects (e.g. local-Risu-imported modules in the
// modules[] array) makes fast-json-patch.compare emit hundreds of thousands
// of element-wise diff ops (every index shifts by one and each slot deep-
// diffs old[i] vs new[i+1]). The resulting `patch.push(...ops)` then trips
// V8's function-argument limit and throws RangeError.
// ──────────────────────────────────────────────────────────────────────────

describe('diffArrayWithIdGuard — id-based structural detection (modules)', () => {
    const A = { id: 'a', name: 'A', cjs: 'console.log("a")' }
    const B = { id: 'b', name: 'B', cjs: 'console.log("b")' }
    const C = { id: 'c', name: 'C', cjs: 'console.log("c")' }
    const D = { id: 'd', name: 'D', cjs: 'console.log("d")' }

    test('delete from front (the cascade case) → single replace, NOT element-wise', () => {
        const ops = diffArrayWithIdGuard(compare, '/modules', [A, B, C, D], [B, C, D], 'id')
        expect(ops).toEqual([{ op: 'replace', path: '/modules', value: [B, C, D] }])
    })

    test('reorder (length unchanged, ids in different positions) → single replace', () => {
        const ops = diffArrayWithIdGuard(compare, '/modules', [A, B, C], [C, A, B], 'id')
        expect(ops).toEqual([{ op: 'replace', path: '/modules', value: [C, A, B] }])
    })

    test('same ids, one item internally changed → element-wise diff for that index only', () => {
        const Bx = { id: 'b', name: 'B-renamed', cjs: 'console.log("b")' }
        const ops = diffArrayWithIdGuard(compare, '/modules', [A, B, C], [A, Bx, C], 'id')
        // Only /modules/1 path should be touched. Exact op shape depends on
        // fast-json-patch's diff strategy but it must be scoped to index 1.
        expect(ops.length).toBeGreaterThan(0)
        for (const op of ops) {
            expect(op.path.startsWith('/modules/1')).toBe(true)
        }
    })

    test('undefined lastArr (cold init) → treated as empty', () => {
        const ops = diffArrayWithIdGuard(compare, '/modules', undefined, [A, B], 'id')
        expect(ops).toEqual([{ op: 'replace', path: '/modules', value: [A, B] }])
    })
})

describe('diffArrayWithIdGuard — ID safety belt', () => {
    // The fix targets corrupted backups where modules may have missing or
    // duplicated ids. Element-wise diff in those states is unreliable, so we
    // force a structural replace instead.

    test('missing id field entirely → structural replace', () => {
        const A = { id: 'a', name: 'A' }
        const Bbad = { name: 'B' } as any
        const ops = diffArrayWithIdGuard(compare, '/modules', [A, { id: 'b', name: 'B' }], [A, Bbad], 'id')
        expect(ops).toEqual([{ op: 'replace', path: '/modules', value: [A, Bbad] }])
    })

    test('duplicate ids in current array → structural replace', () => {
        const A = { id: 'a', name: 'A' }
        const Adup = { id: 'a', name: 'A2' }
        const ops = diffArrayWithIdGuard(compare, '/modules', [A, { id: 'b', name: 'B' }], [A, Adup], 'id')
        expect(ops).toEqual([{ op: 'replace', path: '/modules', value: [A, Adup] }])
    })

})

// ──────────────────────────────────────────────────────────────────────────
// RisuSavePatcher integration — exercise the full set() path.
// ──────────────────────────────────────────────────────────────────────────

function makeMod(id: string, extras: any = {}) {
    return { id, name: `mod-${id}`, description: '', ...extras }
}

const emptyToSave = () => ({
    character: [],
    chat: [] as [string, string][],
    root: false,
    botPreset: false,
    modules: false,
    plugins: false,
    pluginCustomStorage: false,
})

describe('RisuSavePatcher.set — modules path', () => {
    test('deleting a front-loaded module emits a single replace op, no RangeError', async () => {
        const patcher = new RisuSavePatcher()
        const initialModules = [makeMod('a'), makeMod('b'), makeMod('c'), makeMod('d')]
        await patcher.init({ characters: [], botPresets: [], modules: initialModules })

        const newDb = { characters: [], botPresets: [], modules: [makeMod('b'), makeMod('c'), makeMod('d')] }
        const { patch } = await patcher.set(newDb, { ...emptyToSave(), modules: true })

        const moduleOps = patch.filter((p: any) => p.path === '/modules' || p.path.startsWith('/modules/'))
        expect(moduleOps).toEqual([
            { op: 'replace', path: '/modules', value: newDb.modules },
        ])
    })

    test('internal edit only (same id order) → element-wise diff scoped to that index', async () => {
        const patcher = new RisuSavePatcher()
        await patcher.init({
            characters: [],
            botPresets: [],
            modules: [makeMod('a'), makeMod('b', { description: 'old' })],
        })

        const newDb = {
            characters: [],
            botPresets: [],
            modules: [makeMod('a'), makeMod('b', { description: 'new' })],
        }
        const { patch } = await patcher.set(newDb, { ...emptyToSave(), modules: true })

        const moduleOps = patch.filter((p: any) => p.path.startsWith('/modules/'))
        expect(moduleOps.length).toBeGreaterThan(0)
        for (const op of moduleOps) expect(op.path.startsWith('/modules/1')).toBe(true)
        // No structural replace under those circumstances.
        expect(patch.find((p: any) => p.path === '/modules')).toBeUndefined()
    })

    test('does not throw on a pathological array that would crash the original code path', async () => {
        // ~300 modules with non-trivial internals × front delete. Old behavior
        // would balloon the op count and trip `patch.push(...arr)` spread.
        const N = 300
        const big = Array.from({ length: N }, (_, i) => makeMod(`m${i}`, {
            description: 'x'.repeat(200),
            lorebook: Array.from({ length: 10 }, (_, k) => ({ key: `k${k}`, content: 'y'.repeat(100) })),
        }))

        const patcher = new RisuSavePatcher()
        await patcher.init({ characters: [], botPresets: [], modules: big })

        // Delete the very first module — worst-case index cascade.
        const next = big.slice(1)
        const newDb = { characters: [], botPresets: [], modules: next }

        await expect(patcher.set(newDb, { ...emptyToSave(), modules: true })).resolves.toBeTruthy()
    })

})

describe('RisuSavePatcher.set — botPresets path', () => {
    // Each preset gets a stable id (S3) — patcher diffs botPresets by id,
    // same as modules. Reusing `name` as the id keeps fixtures terse.
    const preset = (name: string, extras: any = {}) => ({
        id: name, name, temperature: 80, mainPrompt: 'You are...', ...extras,
    })

    test('deleting a preset from the middle emits a single replace op', async () => {
        const patcher = new RisuSavePatcher()
        await patcher.init({
            characters: [],
            botPresets: [preset('p1'), preset('p2'), preset('p3')],
            modules: [],
        })

        const newDb = {
            characters: [],
            botPresets: [preset('p1'), preset('p3')],
            modules: [],
        }
        const { patch } = await patcher.set(newDb, { ...emptyToSave(), botPreset: true })
        const presetOps = patch.filter((p: any) =>
            p.path === '/botPresets' || p.path.startsWith('/botPresets/'),
        )
        expect(presetOps).toEqual([
            { op: 'replace', path: '/botPresets', value: newDb.botPresets },
        ])
    })

    test('editing one preset (length unchanged) emits scoped element-wise diff', async () => {
        const patcher = new RisuSavePatcher()
        await patcher.init({
            characters: [],
            botPresets: [preset('p1'), preset('p2', { temperature: 70 })],
            modules: [],
        })
        const newDb = {
            characters: [],
            botPresets: [preset('p1'), preset('p2', { temperature: 75 })],
            modules: [],
        }
        const { patch } = await patcher.set(newDb, { ...emptyToSave(), botPreset: true })
        const presetOps = patch.filter((p: any) => p.path.startsWith('/botPresets/'))
        expect(presetOps.length).toBeGreaterThan(0)
        for (const op of presetOps) expect(op.path.startsWith('/botPresets/1')).toBe(true)
        expect(patch.find((p: any) => p.path === '/botPresets')).toBeUndefined()
    })
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

        expect(patch.filter((operation: any) =>
            operation.path.startsWith('/statics/messages')
            || operation.path.startsWith('/characters/0/lastInteraction')),
        ).toEqual([])
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

// ──────────────────────────────────────────────────────────────────────────
// Round-trip integrity — the strongest correctness invariant:
//
//   applyPatch(baseline, patcher.set(newState).patch) === normalize(newState)
//
// In production, the server applies these patches with fast-json-patch's
// applyPatch on its own copy of the DB. If our generated ops don't bring
// the server's baseline up to the same state the patcher computed
// internally, the next save/load round-trip will diverge and the user
// either sees stale data or silent loss. These tests exercise the
// scenarios the fix is meant to handle and verify byte-equivalent
// reconstruction.
// ──────────────────────────────────────────────────────────────────────────

const { applyPatch } = await import('fast-json-patch')
const { normalizeJSON } = await import('./risuSave')

function applyOpsTo(baseline: any, ops: any[]) {
    // fast-json-patch mutates by default; deep-clone first to keep tests
    // independent. Also matches how the server-side applyPatch wraps the
    // call in its own copy of the DB.
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
    // Simulate the server's pre-image: normalized initial state.
    const serverBaseline = normalizeJSON(initial)
    const afterApply = applyOpsTo(serverBaseline, patch)
    // Simulate what the server should end up with: normalized next state,
    // with chats stub-replaced on characters (mirroring patcher.set's diff
    // input). characters are out of scope for this suite (empty arrays),
    // so the transformation collapses to plain normalize.
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

    test('modules: edit content of one (length unchanged, same ids)', async () => {
        const initial = {
            characters: [], botPresets: [],
            modules: [
                { id: 'a', name: 'A', description: 'old' },
                { id: 'b', name: 'B', description: 'untouched' },
            ],
        }
        const next = {
            characters: [], botPresets: [],
            modules: [
                { id: 'a', name: 'A', description: 'NEW VALUE' },
                { id: 'b', name: 'B', description: 'untouched' },
            ],
        }
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
                { id: 'a', name: 'A', description: 'v2' },         // edited
                { id: 'b', name: 'B', description: 'v1' },
                { id: 'c', name: 'C', description: 'new' },        // added
            ],
        }
        const { afterApply, expected } = await runRoundTrip(initial, next, { ...emptyToSave(), modules: true })
        expect(afterApply.modules).toEqual(expected.modules)
    })

    test('modules: 200-module front-delete (the original bug scenario)', async () => {
        function makeMod(i: number) {
            return {
                id: `mod-${i}`,
                name: `Module ${i}`,
                description: `desc ${i}`,
                lorebook: Array.from({ length: 10 }, (_, k) => ({
                    key: `k-${i}-${k}`, content: `v-${i}-${k}`,
                })),
                cjs: `console.log("${i}")`.repeat(10),
            }
        }
        const big = Array.from({ length: 200 }, (_, i) => makeMod(i))
        const initial = { characters: [], botPresets: [], modules: big }
        const next = { characters: [], botPresets: [], modules: big.slice(1) }
        const { patch, afterApply, expected } = await runRoundTrip(initial, next, { ...emptyToSave(), modules: true })
        // Sanity: not exploding into hundreds of thousands of ops
        expect(patch.length).toBeLessThan(20)
        // Server side reconstructs exactly what the patcher computed
        expect(afterApply.modules).toEqual(expected.modules)
    })

    test('botPresets: delete from middle', async () => {
        const p = (name: string, temp = 80) => ({ name, temperature: temp, mainPrompt: 'You are...' })
        const initial = { characters: [], botPresets: [p('p1'), p('p2'), p('p3')], modules: [] }
        const next = { characters: [], botPresets: [p('p1'), p('p3')], modules: [] }
        const { afterApply, expected } = await runRoundTrip(initial, next, { ...emptyToSave(), botPreset: true })
        expect(afterApply.botPresets).toEqual(expected.botPresets)
    })

    test('botPresets: edit one (length unchanged)', async () => {
        const p = (name: string, temp = 80) => ({ name, temperature: temp, mainPrompt: 'You are...' })
        const initial = { characters: [], botPresets: [p('p1', 70), p('p2', 80)], modules: [] }
        const next = { characters: [], botPresets: [p('p1', 70), p('p2', 90)], modules: [] }
        const { afterApply, expected } = await runRoundTrip(initial, next, { ...emptyToSave(), botPreset: true })
        expect(afterApply.botPresets).toEqual(expected.botPresets)
    })

    test('combined: edit modules and botPresets in a single save', async () => {
        const p = (name: string) => ({ name, temperature: 80, mainPrompt: 'You are...' })
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

    test('ID safety belt: duplicate ids still reconstruct correctly', async () => {
        // Pathological — duplicate ids in current state. The structural-replace
        // safety belt kicks in, and the server-side state should still match.
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

// ──────────────────────────────────────────────────────────────────────────
// Cheap-pre-check fast path — state-transition regression suite.
//
// The change-detection fast path compares JSON.stringify(block) against a
// stored baseline string and, on a match, skips normalize + protocol hash +
// diff entirely. The danger is a baseline that drifts out of sync with
// `lastSyncedDb`/`hashBlocks` so that either (a) a real change is skipped
// (silent loss) or (b) `expectedHash` no longer matches what the server holds.
// Each transition below is followed by a no-op save: a correct baseline must
// make the second save emit an empty patch, and a real change after a skip
// must still be caught.
// ──────────────────────────────────────────────────────────────────────────

const chr = (chaId: string, fields: Record<string, any> = {}) => ({
    chaId,
    name: chaId.toUpperCase(),
    desc: '',
    firstMessage: '',
    chats: [{ id: 'chat-' + chaId, name: 'c', _stub: true }],
    chatPage: 0,
    ...fields,
})
const dbWith = (characters: any[], rest: Record<string, any> = {}) => ({
    formatversion: 4, username: 'u', personaPrompt: 'p', botPresets: [], modules: [], characters, ...rest,
})
const clone = (o: any) => JSON.parse(JSON.stringify(o))

describe('fast-path — no-op detection after each transition', () => {
    test('runtime-only reloadKeys changes never produce a database patch', async () => {
        const db = dbWith([chr('a', { reloadKeys: 1 })])
        const p = new RisuSavePatcher()
        await p.init(db)

        const runtimeChanged = clone(db)
        runtimeChanged.characters[0].reloadKeys = 25
        const { patch } = await p.set(runtimeChanged, emptyToSave())

        expect(patch).toEqual([])
    })

    test('init → identical save is a no-op', async () => {
        const db = dbWith([chr('a'), chr('b')])
        const p = new RisuSavePatcher()
        await p.init(db)
        const { patch } = await p.set(clone(db), emptyToSave())
        expect(patch).toEqual([])
    })

    test('root change → saved, then identical re-save is a no-op', async () => {
        const db = dbWith([chr('a')])
        const p = new RisuSavePatcher()
        await p.init(db)

        const changed = clone(db); changed.personaPrompt = 'new persona'
        const r1 = await p.set(clone(changed), { ...emptyToSave(), root: true })
        expect(r1.patch.some((o: any) => o.path === '/personaPrompt')).toBe(true)

        const r2 = await p.set(clone(changed), emptyToSave())
        expect(r2.patch).toEqual([])
    })

    test('character field change → saved, then no-op (caught even with empty toSave.character)', async () => {
        const db = dbWith([chr('a'), chr('b')])
        const p = new RisuSavePatcher()
        await p.init(db)

        const changed = clone(db); changed.characters[1].desc = 'edited B'
        // Deliberately empty toSave.character: the change must be caught by the
        // JSON compare → protocol hash, not by the save-tracker hint.
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

        // First: identical save → fast path skips char 'a' and 'b'.
        expect((await p.set(clone(db), emptyToSave())).patch).toEqual([])

        // Then edit char 'a' (previously skipped). Must be caught.
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
    // normalizeJSON uses path-based cycle detection: a shared (non-cyclic)
    // reference appearing twice is kept in BOTH places (only true cycles are
    // nulled). So raw JSON and the normalized baseline agree on shared-ref data
    // and the fast path is safe — no null to "recover". These pin that the
    // patcher neither corrupts shared-ref data nor emits spurious ops.
    test('character with a shared ref: round-trips without null corruption, then no-op', async () => {
        const { applyPatch: apply } = await import('fast-json-patch')
        const shared = { tag: 'v', n: 1 }
        const base = dbWith([chr('a')])
        const p = new RisuSavePatcher()
        await p.init(base)

        // Introduce a character that holds the same object under two keys.
        const withShared = dbWith([chr('a', { extA: shared, extB: shared })])
        const { patch } = await p.set(withShared, { ...emptyToSave(), character: ['a'] })

        // Server reconstruction must hold the full object in BOTH places (no null).
        const server = JSON.parse(JSON.stringify(normalizeJSON(base)))
        apply(server, patch)
        expect(server.characters[0].extA).toEqual({ tag: 'v', n: 1 })
        expect(server.characters[0].extB).toEqual({ tag: 'v', n: 1 })

        // Identical re-save is a clean no-op (baseline converged).
        expect((await p.set(withShared, emptyToSave())).patch).toEqual([])
    })

    test('a real content change under a shared ref is still caught', async () => {
        const shared = { tag: 'v', n: 1 }
        const p = new RisuSavePatcher()
        await p.init(dbWith([chr('a', { extA: shared, extB: shared })]))

        // Now genuinely change extB's content.
        const changed = dbWith([chr('a', { extA: { tag: 'v', n: 1 }, extB: { tag: 'v', n: 2 } })])
        const { patch } = await p.set(changed, emptyToSave())
        expect(patch.some((o: any) => o.path.startsWith('/characters/0/extB'))).toBe(true)
    })

    test('root-level shared ref round-trips and converges to a no-op', async () => {
        const { applyPatch: apply } = await import('fast-json-patch')
        const shared = { theme: 'x' }
        const base = dbWith([chr('a')])
        const p = new RisuSavePatcher()
        await p.init(base)

        const withShared = dbWith([chr('a')], { sdProvider: shared, customCss: shared } as any)
        const { patch } = await p.set(withShared, { ...emptyToSave(), root: true })
        const server = JSON.parse(JSON.stringify(normalizeJSON(base)))
        apply(server, patch)
        expect(server.sdProvider).toEqual({ theme: 'x' })
        expect(server.customCss).toEqual({ theme: 'x' })

        expect((await p.set(withShared, emptyToSave())).patch).toEqual([])
    })
})

describe('fast-path — expectedHash stays protocol-consistent', () => {
    test('hash after N mutating saves equals a fresh init of the same data', async () => {
        const db = dbWith([chr('a'), chr('b')])
        const live = new RisuSavePatcher()
        await live.init(db)

        // Drive several transitions on the live patcher.
        const s1 = clone(db); s1.personaPrompt = 'x'; await live.set(clone(s1), { ...emptyToSave(), root: true })
        const s2 = clone(s1); s2.characters[0].desc = 'y'; await live.set(clone(s2), emptyToSave())
        const s3 = clone(s2); s3.characters.push(chr('c')); await live.set(clone(s3), emptyToSave())
        const s4 = clone(s3); s4.characters.splice(0, 1); await live.set(clone(s4), emptyToSave())

        // expectedHash of the live patcher's next save (pre-image = current state)
        const liveHash = (await live.set(clone(s4), emptyToSave())).expectedHash

        // A fresh patcher initialised directly to the final state must agree.
        const fresh = new RisuSavePatcher()
        await fresh.init(clone(s4))
        const freshHash = (await fresh.set(clone(s4), emptyToSave())).expectedHash

        expect(liveHash).toBe(freshHash)
    })
})

// ──────────────────────────────────────────────────────────────────────────
// Fast-path granularity — per-ROOT-KEY and per-MODULE pre-checks.
//
// While typing into a root field (personaPrompt) or a module lorebook, that
// block changes on EVERY save, so a per-block pre-check never matches. The
// pre-check is therefore kept per root key / per module: only the changed
// entry pays normalize + protocol hash + diff. These suites pin (a) op scope,
// (b) no-op convergence, (c) protocol-hash parity with a fresh init, and
// (d) the prototype-pollution / key-type hazards of id-keyed caches.
// ──────────────────────────────────────────────────────────────────────────

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
        // A db loaded from JSON can carry an own enumerable "__proto__" key.
        // The old whole-root normalizeJSON dropped it; the per-key path must
        // too, or it emits a /__proto__ op that the server's applyPatch rejects
        // (prototype-pollution guard) — failing every save.
        const { applyPatch: apply } = await import('fast-json-patch')
        const db: any = dbWith([chr('a')])
        Object.defineProperty(db, '__proto__', { value: { polluted: true }, enumerable: true, writable: true, configurable: true })
        expect(Object.keys(db)).toContain('__proto__')

        const p = new RisuSavePatcher()
        await p.init(db)
        const changed = clone(db); changed.personaPrompt = 'edited'
        const { patch } = await p.set(clone(changed), { ...emptyToSave(), root: true })

        expect(patch.some((o: any) => o.path === '/__proto__' || o.path.startsWith('/__proto__/'))).toBe(false)
        expect(patch.some((o: any) => o.path === '/personaPrompt')).toBe(true)
        // The patch must apply cleanly on a normalized server baseline (no throw).
        const serverState = JSON.parse(JSON.stringify(normalizeJSON(db)))
        expect(() => apply(serverState, patch)).not.toThrow()
        // And converge to a no-op.
        expect((await p.set(clone(changed), emptyToSave())).patch).toEqual([])
    })

    test('a root value with toJSON()→undefined is kept, not removed', async () => {
        // normalizeJSON ignores toJSON and keeps {x:1}; the per-key path must
        // decide presence by the normalized result, not by JSON.stringify(raw)
        // (which is undefined here), or it would emit a spurious /weird remove.
        const db: any = dbWith([chr('a')])
        db.weird = { x: 1, toJSON() { return undefined } }
        const p = new RisuSavePatcher()
        await p.init(db)

        // Unchanged save: must be a pure no-op (no remove of /weird).
        const { patch } = await p.set(db, { ...emptyToSave(), root: true })
        expect(patch.some((o: any) => o.path === '/weird' || o.path.startsWith('/weird/'))).toBe(false)
        expect(patch).toEqual([])

        const liveHash = (await p.set(db, emptyToSave())).expectedHash
        const fresh = new RisuSavePatcher(); await fresh.init(db)
        expect(liveHash).toBe((await fresh.set(db, emptyToSave())).expectedHash)
    })

    test('a top-level bigint root value drops cleanly — no undefined baseline / hash stays consistent', async () => {
        // bigint: JSON.stringify throws and normalizeJSON maps it to undefined,
        // so its key is dropped. The patcher must not store an undefined
        // baseline/hash for it (which would diverge from a fresh init).
        const db: any = dbWith([chr('a')])
        db.bsig = 123n
        const p = new RisuSavePatcher()
        await p.init(db)
        await p.set(db, { ...emptyToSave(), root: true })

        const liveHash = (await p.set(db, emptyToSave())).expectedHash
        const fresh = new RisuSavePatcher(); await fresh.init(db)
        const freshHash = (await fresh.set(db, emptyToSave())).expectedHash
        expect(liveHash).toBe(freshHash)
    })

    test('per-key ops reconstruct the same server state as a whole-root diff would', async () => {
        const { applyPatch: apply } = await import('fast-json-patch')
        const db = dbWith([chr('a')], { sdProvider: { x: 1 }, themeList: ['a', 'b'] } as any)
        const p = new RisuSavePatcher()
        await p.init(db)

        const changed = clone(db)
        changed.personaPrompt = 'new'
        changed.sdProvider = { x: 2, y: 3 }
        delete changed.themeList
        const { patch } = await p.set(clone(changed), { ...emptyToSave(), root: true })

        const serverState = JSON.parse(JSON.stringify(normalizeJSON(db)))
        apply(serverState, patch)
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

    test('modules protocol hash from cached item hashes equals a fresh full hash', async () => {
        const db = dbWith([chr('a')], { } as any)
        db.modules = [mod('m1', 'aaa'), mod('m2', 'bbb')]
        const live = new RisuSavePatcher()
        await live.init(db)

        // Mutate one module via the element-wise path, then another save.
        const s1 = clone(db); s1.modules[0].lorebook[0].content = 'x1'
        await live.set(clone(s1), { ...emptyToSave(), modules: true })
        const s2 = clone(s1); s2.modules[1].name = 'renamed'
        await live.set(clone(s2), { ...emptyToSave(), modules: true })

        const liveHash = (await live.set(clone(s2), emptyToSave())).expectedHash
        const fresh = new RisuSavePatcher()
        await fresh.init(clone(s2))
        const freshHash = (await fresh.set(clone(s2), emptyToSave())).expectedHash
        expect(liveHash).toBe(freshHash)
    })

    test('module id "__proto__" cannot poison the caches — protocol hash stays consistent', async () => {
        // Plain-object caches would silently hit the prototype setter for this
        // id (storing nothing / returning Object.prototype), corrupting the
        // skip check and the hash fold. Map caches must handle it strictly.
        const db = dbWith([chr('a')], { } as any)
        db.modules = [mod('__proto__', 'aaa'), mod('m2', 'bbb')]
        const live = new RisuSavePatcher()
        await live.init(db)

        const s1 = clone(db); s1.modules[0].lorebook[0].content = 'edited'
        const r1 = await live.set(clone(s1), { ...emptyToSave(), modules: true })
        expect(r1.patch.some((o: any) => o.path.startsWith('/modules/0'))).toBe(true)
        expect((await live.set(clone(s1), { ...emptyToSave(), modules: true })).patch).toEqual([])

        const liveHash = (await live.set(clone(s1), emptyToSave())).expectedHash
        const fresh = new RisuSavePatcher()
        await fresh.init(clone(s1))
        const freshHash = (await fresh.set(clone(s1), emptyToSave())).expectedHash
        expect(liveHash).toBe(freshHash)
    })

    test('non-string module ids (1 vs "1") force the structural path — no key collision', async () => {
        const db = dbWith([chr('a')], { } as any)
        db.modules = [{ ...mod('x'), id: 1 as any }, { ...mod('y'), id: '1' }]
        const live = new RisuSavePatcher()
        await live.init(db)

        // Numeric id → structural fallback: whole-array replace, never element-wise.
        const s1 = clone(db); s1.modules[0].lorebook[0].content = 'edited'
        const r1 = await live.set(clone(s1), { ...emptyToSave(), modules: true })
        expect(r1.patch.length).toBe(1)
        expect(r1.patch[0].path).toBe('/modules')

        const liveHash = (await live.set(clone(s1), emptyToSave())).expectedHash
        const fresh = new RisuSavePatcher()
        await fresh.init(clone(s1))
        const freshHash = (await fresh.set(clone(s1), emptyToSave())).expectedHash
        expect(liveHash).toBe(freshHash)
    })
})
