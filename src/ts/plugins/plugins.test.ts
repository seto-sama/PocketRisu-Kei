import { beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ db: { plugins: [] } as Record<string, any> }))
vi.mock('src/lang', () => ({ language: { pluginApiUnsupported: 'API 3.0 required' } }))
vi.mock('src/ts/storage/database.svelte', () => ({
    getDatabase: () => state.db,
    setDatabaseLite: vi.fn(),
}))
vi.mock('src/ts/stores.svelte', () => ({ DBState: state }))
vi.mock('src/ts/alert', () => ({ alertConfirm: vi.fn(async () => true), alertError: vi.fn() }))
vi.mock('src/ts/util', () => ({ selectSingleImportFile: vi.fn() }))
vi.mock('src/ts/globalApi.svelte', () => ({ requestImmediateSave: vi.fn(async () => {}) }))
vi.mock('./apiV3/v3.svelte', () => ({ loadV3Plugins: vi.fn(), reloadV3Plugin: vi.fn() }))
vi.mock('./apiV3/transpiler', () => ({ pluginCodeTranspiler: vi.fn(async code => code) }))
vi.mock('./pluginMemorySafety', () => ({ pluginDisabledForMemorySession: (plugin: { name: string }) => plugin.name === 'session-disabled' }))

import { alertError } from '../alert'
import { loadV3Plugins, reloadV3Plugin } from './apiV3/v3.svelte'
import { pluginCodeTranspiler } from './apiV3/transpiler'
import { importPlugin, loadPlugins } from './plugins.svelte'

beforeEach(() => {
    vi.clearAllMocks()
    state.db = { plugins: [], pluginCustomStorage: { retained: 'data' }, allowV2Plugin: true }
})

describe('plugin API support', () => {
    it.each(['2.0', '2.1', '4.0', undefined])('rejects unsupported API %s before installation or execution', async version => {
        const script = `//@name plugin\n${version ? `//@api ${version}\n` : ''}throw new Error('must not execute')`
        const before = structuredClone(state.db)
        expect(await importPlugin(script, { isTypescript: true })).toBe(false)
        expect(alertError).toHaveBeenCalledWith('API 3.0 required')
        expect(pluginCodeTranspiler).not.toHaveBeenCalled()
        expect(loadV3Plugins).not.toHaveBeenCalled()
        expect(state.db).toEqual(before)
    })

    it('keeps old source and settings while loading only enabled supported plugins', async () => {
        state.db.plugins = [
            { name: 'v2', version: 2, enabled: true, script: 'old script', realArg: { key: 'old' } },
            { name: 'v2.1', version: '2.1', enabled: true, script: 'old script' },
            { name: 'v3', version: '3.0', enabled: true, script: 'supported script' },
            { name: 'off', version: '3.0', enabled: false },
            { name: 'session-disabled', version: '3.0', enabled: true },
        ]
        const before = structuredClone(state.db)
        await loadPlugins()
        expect(loadV3Plugins).toHaveBeenCalledWith([state.db.plugins[2]])
        expect(state.db).toEqual(before)
    })

    it('upgrades an installed legacy plugin to declared API 3.0 without losing its arguments or storage', async () => {
        state.db.plugins = [{
            name: 'plugin', version: '2.1', enabled: true, script: 'old script',
            arguments: { token: 'string' }, realArg: { token: 'saved token' },
        }]
        const script = '//@name plugin\n//@api 2.0 2.1 3.0\n//@arg token string\nRisuai.log("updated")'
        expect(await importPlugin(script, { isUpdate: true, originalPluginName: 'plugin' })).toBe(true)
        expect(state.db.plugins).toHaveLength(1)
        expect(state.db.plugins[0]).toMatchObject({ name: 'plugin', version: '3.0', script, realArg: { token: 'saved token' } })
        expect(loadV3Plugins).toHaveBeenCalledWith([state.db.plugins[0]])
        expect(state.db.pluginCustomStorage).toEqual({ retained: 'data' })
    })

    it.each([true, false])('preserves enabled=%s when updating a V3 plugin', async enabled => {
        state.db.plugins = [{ name: 'plugin', version: '3.0', enabled, script: 'old source' }]
        expect(await importPlugin('//@name plugin\n//@api 3.0', { isUpdate: true })).toBe(true)
        expect(state.db.plugins[0].enabled).toBe(enabled)
        if (enabled) {
            expect(reloadV3Plugin).toHaveBeenCalledWith(state.db.plugins[0])
            expect(loadV3Plugins).not.toHaveBeenCalled()
        } else {
            expect(reloadV3Plugin).not.toHaveBeenCalled()
            expect(loadV3Plugins).toHaveBeenCalledWith([])
        }
    })
})
