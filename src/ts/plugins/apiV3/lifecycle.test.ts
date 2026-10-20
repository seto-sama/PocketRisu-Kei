import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const bridge = vi.hoisted(() => ({ apis: [] as any[], scripts: [] as string[], terminate: vi.fn() }))
vi.mock('./factory', () => ({
    getRpcAbortSignalMetadata: vi.fn(),
    setRpcAbortSignalMetadata: vi.fn(),
    SandboxHost: class {
        constructor(api: unknown) { bridge.apis.push(api) }
        run(_iframe: HTMLIFrameElement, script: string) { bridge.scripts.push(script) }
        terminate() { bridge.terminate() }
    },
}))

import { DBState } from '../../stores.svelte'
import { loadPlugins } from '../plugins.svelte'
import { pluginRuntime } from '../pluginRuntime'
import { customV3ProviderMetaStore, loadV3Plugins, reloadV3Plugin } from './v3.svelte'
import { forageStorage } from '../../storage/autoStorage'

beforeEach(() => {
    bridge.apis.length = 0
    bridge.scripts.length = 0
    vi.clearAllMocks()
})

afterEach(async () => {
    await loadV3Plugins([])
    document.body.replaceChildren()
    localStorage.clear()
    vi.restoreAllMocks()
})

it('connects V3 providers, hooks, and storage through the sandbox and cleans them up on unload', async () => {
    DBState.db = {
        plugins: [
            { name: 'old', version: 2, enabled: true, script: 'old source' },
            { name: 'current', version: '3.0', enabled: true, script: 'current source' },
        ],
        pluginCustomStorage: {}, pluginStorageMeta: {},
    } as any
    await loadPlugins()
    expect(bridge.scripts).toEqual(['current source'])
    const api = bridge.apis[0]
    const provider = vi.fn(async () => ({ success: true, content: 'response' }))
    const scriptHandler = vi.fn((text: string) => `${text}!`)
    const chatListener = vi.fn()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    api.addProvider('provider', provider, { model: { name: 'Provider model' } })
    api.addRisuScriptHandler('input', scriptHandler)
    await api.addRisuChatListener('output', chatListener)
    expect(pluginRuntime.providers.has('provider')).toBe(true)
    expect(customV3ProviderMetaStore.map(model => model.name)).toEqual(['Provider model'])
    expect([...pluginRuntime.editinput][0]('text')).toBe('text!')
    expect(pluginRuntime.chatOutput.has(chatListener)).toBe(true)

    const aliases = api._getAliases()
    api[aliases.pluginStorage.setItem]('json', '{ "keep": "string" }')
    expect(api[aliases.pluginStorage.getItem]('json')).toBe('{ "keep": "string" }')
    const values = new Map<string, Uint8Array>()
    vi.spyOn(forageStorage, 'pluginStorageRequest').mockImplementation(async (_namespace, request) => {
        if (request.op === 'set') {
            values.set(request.key, request.value)
            return { success: true }
        }
        if (request.op === 'list') {
            return { entries: [...values.keys()].map(key => ({ key })) }
        }
        if (request.op === 'get') return { value: values.get(request.key) ?? null }
        if (request.op === 'remove') {
            values.delete(request.key)
            return { success: true }
        }
        if (request.op === 'clear') {
            values.clear()
            return { success: true }
        }
        if (request.op === 'import') return { success: true }
        throw new Error('Unexpected plugin storage operation')
    })
    await api[aliases.safeLocalStorage.setItem]('key', 'value')
    expect(await api[aliases.safeLocalStorage.getItem]('key')).toBe('value')
    expect(await api[aliases.safeLocalStorage.key](0)).toBe('key')
    expect(await api[aliases.safeLocalStorage.length]()).toBe(1)

    await loadV3Plugins([])
    expect(pluginRuntime.providers.size).toBe(0)
    expect(pluginRuntime.editinput.size).toBe(0)
    expect(pluginRuntime.chatOutput.size).toBe(0)
    expect(customV3ProviderMetaStore).toHaveLength(0)
    expect(bridge.terminate).toHaveBeenCalledOnce()
    expect(DBState.db.plugins[0]).toMatchObject({ version: 2, enabled: true, script: 'old source' })
})

it('removes every provider registration owned by a plugin when it reloads', async () => {
    DBState.db = { plugins: [{ name: 'current', version: '3.0', enabled: true, script: '' }] } as any
    await loadPlugins()
    const api = bridge.apis[0]
    const provider = async () => ({ success: true, content: 'response' })
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    api.addProvider('provider', provider, { model: { name: 'First registration' } })
    api.addProvider('provider', provider, { model: { name: 'Replacement' } })

    await reloadV3Plugin(DBState.db.plugins[0])

    expect(pluginRuntime.providers.size).toBe(0)
    expect(customV3ProviderMetaStore).toHaveLength(0)
    expect(bridge.terminate).toHaveBeenCalledOnce()
})
