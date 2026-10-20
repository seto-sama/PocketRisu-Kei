import { describe, expect, it, vi } from 'vitest'
import { defaultColorScheme, exportColorSchemeWithAliases, withExportColorSchemes, normalizeColorScheme } from '../../../server/shared/colorScheme.js'

vi.mock('../stores.svelte', () => ({ DBState: { db: {} }, selectedCharID: { subscribe: () => () => {} }, selIdState: { selId: -1 } }))
const { forageStorage, requestImmediateSave } = vi.hoisted(() => {
    const encodeFile = vi.fn(async (_format: string, value: unknown) => new TextEncoder().encode(
        JSON.stringify(value, null, 2),
    ))
    const forageStorage = { realStorage: null, encodeFile }
    const requestImmediateSave = vi.fn(async () => {})
    return { forageStorage, requestImmediateSave }
})
vi.mock('../globalApi.svelte', () => ({
    forageStorage, saveAsset: async () => '', requestImmediateSave,
}))
vi.mock('../download', () => ({ downloadFile: vi.fn(async () => {}) }))
vi.mock('../storage/autoStorage', () => ({ forageStorage }))
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
        const { downloadFile } = await import('../download')
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
            await exportColorScheme()
            const result = JSON.parse(vi.mocked(downloadFile).mock.calls.at(-1)![1] as string)
            assertScheme(result, normalizeColorScheme(definition.colors))
            for (const key of ['label', 'legacy', 'colors']) expect(result).not.toHaveProperty(key)
            expect(DBState.db).toEqual(before)
        }
    })
    it('exports current and saved theme JSON without changing presets or waiting for database saves', async () => {
        const { DBState } = await import('../stores.svelte')
        const { downloadFile } = await import('../download')
        const { downloadThemePreset } = await import('../storage/database.svelte')
        const db = { colorScheme: scheme, colorSchemeName: 'custom', theme: 'standard', themePresetsId: 0, themePresets: [{ name: 'Active', colorScheme: { ...scheme, lightbg: '#999999' } }, { name: 'Saved', colorScheme: scheme }] }
        DBState.db = db as any
        const before = structuredClone(db)
        for (const id of [0, 1]) {
            await downloadThemePreset(id)
            const json = JSON.parse(new TextDecoder().decode(vi.mocked(downloadFile).mock.calls.at(-1)![1] as Uint8Array))
            assertScheme(json.colorScheme)
            expect(downloadFile).toHaveBeenLastCalledWith(`${db.themePresets[id].name}_theme.json`, expect.any(Uint8Array))
            expect(db).toEqual(before)
        }
        expect(requestImmediateSave).not.toHaveBeenCalled()
    })
})
