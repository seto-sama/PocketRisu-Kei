import { describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { webcrypto } from 'node:crypto'
import { decompressSync } from 'fflate'
import { decode } from 'msgpackr'
import { defaultColorScheme, exportColorSchemeWithAliases, withExportColorSchemes, normalizeColorScheme } from '../../../server/shared/colorScheme.js'

vi.mock('../stores.svelte', () => ({ DBState: { db: {} }, selectedCharID: { subscribe: () => () => {} }, selIdState: { selId: -1 } }))
const backupEntries = vi.hoisted(() => [] as Array<{ name: string, data: Uint8Array }>)
vi.mock('../globalApi.svelte', () => ({
    forageStorage: { realStorage: null }, downloadFile: vi.fn(), saveAsset: async () => '',
    LocalWriter: class {
        async init() { return true }
        async writeBackup(name: string, data: Uint8Array) { backupEntries.push({ name, data }) }
        async close() {}
    },
}))
vi.mock('../storage/autoStorage', () => ({ forageStorage: { realStorage: null } }))
vi.mock('../alert', () => ({ notifySuccess: () => {}, alertError: () => {}, alertConfirm: async () => true, alertWait: () => {} }))
vi.mock('../../lang', () => ({ language: {}, changeLanguage: () => {} }))

const pairs = { bgcolor: 'lightbg', borderc: 'lightborderc', darkBorderc: 'darkborderc', darkbutton: 'button', textcolor: 'maintext', textcolor2: 'subtext', draculared: 'danger' }
const scheme = { ...defaultColorScheme, lightbg: '#123456', accent: '#abcdef', scoped: '#654321', futureToken: '#112233' }
function assertScheme(value, source: typeof defaultColorScheme = scheme) {
    for (const [alias, key] of Object.entries(pairs)) expect(value[alias]).toBe(source[key])
    for (const key of Object.keys(source)) expect(value[key]).toEqual(source[key])
}

describe('export color compatibility', () => {
    it('copies active and saved colors, retaining extensions and preferring canonical values', () => {
        const source = { colorScheme: { ...scheme, bgcolor: '#000000' }, themePresets: [{ colorScheme: scheme }] }
        const before = structuredClone(source)
        const result = withExportColorSchemes(source)
        assertScheme(result.colorScheme)
        assertScheme(result.themePresets[0].colorScheme)
        expect(source).toEqual(before)
        expect(result.themePresets[0]).not.toBe(source.themePresets[0])
        expect(normalizeColorScheme(result.colorScheme)?.accent).toBe(scheme.accent)
    })
    it.each([undefined, null, {}, { bgcolor: '#123456', accent: '#abcdef' }, { lightbg: undefined, textcolor: '#123123', type: 'invalid' }])('repairs missing/old colors: %j', input => {
        const result = exportColorSchemeWithAliases(input)
        for (const key of [...Object.keys(pairs), 'darkbg', 'selected', 'primary', 'type']) expect(typeof result[key]).toBe('string')
        if (input?.bgcolor) expect(result.bgcolor).toBe(input.bgcolor)
        if (input?.textcolor) expect(result.textcolor).toBe(input.textcolor)
        if (input?.accent) expect(result.accent).toBe(input.accent)
    })
    it('exports every built-in palette without leaking display metadata into the DB or file', async () => {
        const { DBState } = await import('../stores.svelte')
        const { downloadFile } = await import('../globalApi.svelte')
        const { colorSchemes, changeColorScheme, exportColorScheme } = await import('./colorscheme')
        for (const [name, definition] of Object.entries(colorSchemes)) {
            DBState.db = {} as any
            changeColorScheme(name)
            expect(DBState.db.colorSchemeName).toBe(name)
            expect(DBState.db.colorScheme).not.toBe(definition.colors)
            for (const key of ['label', 'legacy', 'colors', ...Object.keys(pairs)]) {
                expect(DBState.db.colorScheme).not.toHaveProperty(key)
            }
            const before = structuredClone(DBState.db)
            exportColorScheme()
            const result = JSON.parse(vi.mocked(downloadFile).mock.calls.at(-1)![1] as string)
            assertScheme(result, normalizeColorScheme(definition.colors))
            for (const key of ['label', 'legacy', 'colors']) expect(result).not.toHaveProperty(key)
            expect(DBState.db).toEqual(before)
        }
    })
    it('serializes compatible colors in the partial backup database entry', async () => {
        const { DBState } = await import('../stores.svelte')
        const { SavePartialLocalBackup } = await import('../drive/backuplocal')
        const { decodeRisuSave } = await import('../storage/risuSave')
        const db = { characters: [], colorScheme: scheme, themePresets: [{ name: 'Saved', colorScheme: scheme }] }
        DBState.db = db as any
        const before = structuredClone(db)
        await SavePartialLocalBackup()
        const data = await decodeRisuSave(backupEntries.find(entry => entry.name === 'database.risudat')!.data)
        assertScheme(data.colorScheme)
        assertScheme(data.themePresets[0].colorScheme)
        expect(db).toEqual(before)
    })
    it('exports color JSON and both theme containers without changing the DB or saved presets', async () => {
        const { DBState } = await import('../stores.svelte')
        const { downloadFile } = await import('../globalApi.svelte')
        const { exportColorScheme } = await import('./colorscheme')
        const { downloadThemePreset } = await import('../storage/database.svelte')
        const { decryptBuffer } = await import('../util')
        const { decodeRPack } = await import('../rpack/rpack_js')
        const db = { colorScheme: scheme, colorSchemeName: 'custom', theme: 'standard', themePresetsId: 0, themePresets: [{ name: 'Active', colorScheme: { ...scheme, lightbg: '#999999' } }, { name: 'Saved', colorScheme: scheme }] }
        DBState.db = db as any
        const before = structuredClone(db)
        exportColorScheme()
        assertScheme(JSON.parse(vi.mocked(downloadFile).mock.calls.at(-1)![1] as string))
        const cryptoDescriptor = Object.getOwnPropertyDescriptor(window, 'crypto')
        Object.defineProperty(window, 'crypto', { configurable: true, value: webcrypto })
        const map = readFileSync('src/ts/rpack/rpack_map.bin')
        const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(map))
        try {
            for (const id of [0, 1]) {
                await downloadThemePreset(id, 'json')
                assertScheme(JSON.parse(Buffer.from(vi.mocked(downloadFile).mock.calls.at(-1)![1] as Uint8Array).toString()).colorScheme)
                await downloadThemePreset(id, 'risutheme')
                const bytes = vi.mocked(downloadFile).mock.calls.at(-1)![1]
                const envelope = decode(decompressSync(await decodeRPack(bytes)))
                expect(envelope.type).toBe('theme')
                expect(envelope.presetVersion).toBe(1)
                const preset = decode(new Uint8Array(await decryptBuffer(envelope.preset, 'risutheme')))
                assertScheme(preset.colorScheme)
                expect(db).toEqual(before)
            }
        } finally {
            fetchMock.mockRestore()
            if (cryptoDescriptor) Object.defineProperty(window, 'crypto', cryptoDescriptor)
            else Reflect.deleteProperty(window, 'crypto')
        }
    })
})
