import { beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ db: {} as Record<string, any> }))

vi.mock('src/lang', () => ({
    language: {
        confirmInstallPluginViaPlugin: 'Install {plugin}?',
        pluginApiUnsupported: 'API 3.0 required',
        errors: { noData: 'No data' },
    },
}))
vi.mock('src/ts/storage/database.svelte', () => ({
    getDatabase: () => state.db,
    setDatabase: (db: Record<string, any>) => { state.db = db },
    setDatabaseLite: vi.fn(),
    getCurrentCharacter: vi.fn(),
}))
vi.mock('src/ts/stores.svelte', () => ({
    DBState: {
        get db() { return state.db },
        set db(db: Record<string, any>) { state.db = db },
    },
    selectedCharID: { subscribe: vi.fn() },
}))
vi.mock('src/ts/storage/chatSelection.svelte', () => ({
    initializeChatSelection: vi.fn(),
    withChatSelection: vi.fn(value => value),
}))
vi.mock('src/ts/globalApi.svelte', () => ({
    fetchNative: vi.fn(),
    globalFetch: vi.fn(),
    readImage: vi.fn(),
    saveAsset: vi.fn(),
    requestImmediateSave: vi.fn(async () => {}),
}))
vi.mock('../alert', () => ({
    alertConfirm: vi.fn(async (message: string) => !message.includes('denied')),
    alertError: vi.fn(),
}))
vi.mock('../util', () => ({ selectSingleImportFile: vi.fn() }))
vi.mock('./apiV3/v3.svelte', () => ({ loadV3Plugins: vi.fn(), reloadV3Plugin: vi.fn() }))
vi.mock('./apiV3/transpiler', () => ({ pluginCodeTranspiler: vi.fn(async (code: string) => code) }))
vi.mock('./pluginMemorySafety', () => ({ pluginDisabledForMemorySession: vi.fn(() => false) }))
vi.mock('./pluginSafeClass', () => ({ SafeLocalStorage: class {} }))

import { alertConfirm } from '../alert'
import { createPluginApis } from './pluginApi.svelte'

const createApi = () => createPluginApis('installer-test')

beforeEach(() => {
    vi.clearAllMocks()
    state.db = { plugins: [], pluginCustomStorage: {} }
})

describe('plugin API database writes', () => {
    it('preserves installed plugins and order while applying ordinary allowed settings writes', async () => {
        const installed = [
            { name: 'first', version: '3.0', script: 'first source', enabled: true, realArg: { token: 'one' } },
            { name: 'second', version: '3.0', script: 'second source', enabled: false },
        ]
        state.db = { plugins: installed, pluginCustomStorage: {}, temperature: 0.7 }
        const incoming = structuredClone(state.db)
        incoming.temperature = 1.1

        await createApi().setDatabase(incoming)

        expect(state.db.plugins).toEqual(installed)
        expect(state.db.temperature).toBe(1.1)
        expect(alertConfirm).not.toHaveBeenCalled()
    })

    it('does not treat an empty or declined plugin list as an uninstall request', async () => {
        const installed = [
            { name: 'first', version: '3.0', script: 'first source', enabled: true },
            { name: 'second', version: '3.0', script: 'second source', enabled: true },
        ]
        state.db = { plugins: installed, pluginCustomStorage: {} }

        await createApi().setDatabase({ plugins: [] })
        expect(state.db.plugins).toEqual(installed)

        await createApi().setDatabase({ plugins: [
            { name: 'denied addition', version: '3.0', script: 'new source', enabled: true },
        ] })
        expect(state.db.plugins).toEqual(installed)
        expect(alertConfirm).toHaveBeenCalledOnce()
    })

    it('keeps installed plugins and appends only approved supported v3 plugins', async () => {
        const installed = [{ name: 'installed', version: '3.0', script: 'stored source', enabled: true }]
        state.db = { plugins: installed, pluginCustomStorage: {} }

        await createApi().setDatabase({ plugins: [
            { name: 'approved addition', version: '3.0', script: 'approved source', enabled: true },
            { name: 'denied addition', version: '3.0', script: 'denied source', enabled: true },
            { name: 'unsupported addition', version: '2.1', script: 'old source', enabled: true },
        ] })

        expect(state.db.plugins).toEqual([
            installed[0],
            { name: 'approved addition', version: '3.0', script: 'approved source', enabled: true },
        ])
    })

    it('replaces an approved same-name update in place without duplicating it', async () => {
        const installed = [
            { name: 'first', version: '3.0', script: 'old source', enabled: true },
            { name: 'middle', version: '3.0', script: 'middle source', enabled: true },
            { name: 'last', version: '3.0', script: 'last source', enabled: true },
        ]
        state.db = { plugins: installed, pluginCustomStorage: {} }
        const update = { name: 'first', version: '3.0', script: 'updated source', enabled: false }

        await createApi().setDatabase({ plugins: [update] })

        expect(state.db.plugins).toEqual([update, installed[1], installed[2]])
    })

    it('preserves the stored entry when the script is unchanged and only plugin settings differ', async () => {
        const installed = {
            name: 'plugin', version: '3.0', script: 'same source', enabled: true,
            realArg: { token: 'stored value' }, displayName: 'Stored name',
        }
        state.db = { plugins: [installed], pluginCustomStorage: {} }
        const changedSettings = {
            ...structuredClone(installed),
            enabled: false,
            realArg: { token: 'untrusted value' },
            displayName: 'Untrusted name',
        }

        await createApi().setDatabase({ plugins: [changedSettings] })

        expect(state.db.plugins).toEqual([installed])
    })

    it('installs an approved plugin when the stored database has no plugins list yet', async () => {
        state.db = { pluginCustomStorage: {} }
        const incoming = { name: 'first plugin', version: '3.0', script: 'new source', enabled: true }

        await createApi().setDatabase({ plugins: [incoming] })

        expect(state.db.plugins).toEqual([incoming])
        expect(alertConfirm).toHaveBeenCalledOnce()
    })
})
