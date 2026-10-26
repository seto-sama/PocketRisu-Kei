import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const bridge = vi.hoisted(() => ({
    apis: [] as any[],
    scripts: [] as string[],
    terminate: vi.fn(),
    nativeFetch: vi.fn(),
}))
vi.mock('./factory', () => ({
    getRpcAbortSignalMetadata: vi.fn(),
    setRpcAbortSignalMetadata: vi.fn(),
    SandboxHost: class {
        constructor(api: unknown) { bridge.apis.push(api) }
        run(_iframe: HTMLIFrameElement, script: string) { bridge.scripts.push(script) }
        terminate() { bridge.terminate() }
    },
}))
vi.mock('../pluginApi.svelte', async importOriginal => {
    const actual = await importOriginal<typeof import('../pluginApi.svelte')>()
    return {
        ...actual,
        createPluginApis: (pluginName: string) => ({
            ...actual.createPluginApis(pluginName),
            nativeFetch: bridge.nativeFetch,
        }),
    }
})
vi.mock('src/ts/alert', async importOriginal => {
    const actual = await importOriginal<typeof import('src/ts/alert')>()
    return { ...actual, alertConfirm: vi.fn(async () => true), alertNormalWait: vi.fn(async () => {}) }
})
vi.mock('src/ts/storage/persistentKv', async importOriginal => {
    const actual = await importOriginal<typeof import('src/ts/storage/persistentKv')>()
    return {
        ...actual,
        readPersistentJson: vi.fn(async () => null),
        writePersistentJson: vi.fn(async () => {}),
        removePersistentKey: vi.fn(async () => {}),
    }
})

import { DBState } from '../../stores.svelte'
import { loadPlugins } from '../plugins.svelte'
import { pluginProviderRequestContextKey, pluginRuntime, type ReplacerFunction } from '../pluginRuntime'
import { customV3ProviderMetaStore, loadV3Plugins, reloadV3Plugin, resetAllPluginPermissions, resetPluginPermission } from './v3.svelte'
import { forageStorage } from '../../storage/autoStorage'
import { alertConfirm, alertNormalWait } from 'src/ts/alert'

beforeEach(() => {
    bridge.apis.length = 0
    bridge.scripts.length = 0
    vi.clearAllMocks()
    bridge.nativeFetch.mockResolvedValue(new Response('{"ok":true}', { status: 200 }))
})

afterEach(async () => {
    await loadV3Plugins([])
    await resetAllPluginPermissions()
    document.body.replaceChildren()
    localStorage.clear()
    vi.restoreAllMocks()
})

it('protects Kei routes and keeps provider ancillary requests on the server transport', async () => {
    DBState.db = {
        plugins: [{ name: 'current', version: '3.0', enabled: true, script: 'current source' }],
        pluginCustomStorage: {}, pluginStorageMeta: {},
    } as any
    await loadPlugins()
    const api = bridge.apis[0]
    await expect(api.nativeFetch('/api/characters', { method: 'GET' }))
        .rejects.toThrow('read-only assets')
    expect(bridge.nativeFetch).not.toHaveBeenCalled()

    vi.spyOn(console, 'warn').mockImplementation(() => {})
    api.addProvider('provider', async (_arg: unknown, signal?: AbortSignal) => {
        const response = await api.nativeFetch('https://provider.example/oauth/token', {
            method: 'POST',
            body: '{}',
            headers: { Authorization: 'Bearer provider-token' },
            signal,
            serverProviderAuth: { kind: 'google-service-account', serviceAccountJson: 'forged' },
            networkRoute: 'local_network',
            chatId: 'forged',
            generationRequest: { id: 'forged' },
            interceptor: 'forged',
            llmExecutionPolicy: { kind: 'workflow', durability: 'required', providerRoute: 'direct' },
        })
        expect(response.ok).toBe(true)

        const legacyResult = await api.risuFetch('https://provider.example/oauth/token', {
            method: 'POST',
            body: { refresh_token: 'legacy-body' },
            signal,
        })
        expect(legacyResult).toMatchObject({ ok: true, data: { ok: true }, status: 200 })
        await api.nativeFetch('/assets/provider-icon.png', { method: 'GET', signal })
        return { success: true, content: 'done' }
    })

    const providerArg: any = { prompt_chat: [] }
    Object.defineProperty(providerArg, pluginProviderRequestContextKey, {
        value: { interceptor: 'host-owned-context' },
    })
    await expect(pluginRuntime.providers.get('provider')!(providerArg)).resolves.toMatchObject({
        success: true,
        content: 'done',
    })

    expect(bridge.nativeFetch).toHaveBeenCalledTimes(3)
    const [providerUrl, providerOptions] = bridge.nativeFetch.mock.calls[0]
    expect(providerUrl).toBe('https://provider.example/oauth/token')
    expect(providerOptions).toMatchObject({
        method: 'POST',
        body: '{}',
        llmExecutionPolicy: { kind: 'ephemeral', durability: 'off', providerRoute: 'server' },
    })
    expect(new Headers(providerOptions.headers).get('authorization')).toBe('Bearer provider-token')
    for (const injected of [
        'serverProviderAuth', 'networkRoute', 'chatId', 'generationRequest', 'interceptor',
    ]) expect(providerOptions).not.toHaveProperty(injected)
    expect(providerOptions).not.toHaveProperty('redirect')

    const [, legacyOptions] = bridge.nativeFetch.mock.calls[1]
    expect(legacyOptions).toMatchObject({
        body: '{"refresh_token":"legacy-body"}',
        llmExecutionPolicy: { kind: 'ephemeral', durability: 'off', providerRoute: 'server' },
    })
    expect(new Headers(legacyOptions.headers).get('content-type')).toBe('application/json')

    const [assetUrl, assetOptions] = bridge.nativeFetch.mock.calls[2]
    expect(assetUrl).toBe(new URL('/assets/provider-icon.png', window.location.href).href)
    expect(assetOptions).toMatchObject({
        llmExecutionPolicy: { kind: 'ephemeral', durability: 'off', providerRoute: 'direct' },
        redirect: 'error',
    })
})

it('preserves pre-encoded generation bodies in legacy provider requests', async () => {
    DBState.db = {
        plugins: [{ name: 'current', version: '3.0', enabled: true, script: 'current source' }],
        pluginCustomStorage: {},
    } as any
    await loadPlugins()
    const api = bridge.apis[0]
    const placeholder = '__WORKFLOW_PROMPT__'
    const body = JSON.stringify({ model: 'model', messages: [{ role: 'user', content: placeholder }], stream: true })
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    api.addProvider('provider', async () => {
        const response = await api.risuFetch('https://api.example/v1/chat/completions', {
            method: 'POST', body, headers: { 'Content-Type': 'application/json' },
        })
        return { success: response.ok, content: 'done' }
    })
    const providerArg: any = { prompt_chat: [] }
    Object.defineProperty(providerArg, pluginProviderRequestContextKey, {
        value: {
            interceptor: 'model_preset',
            llmExecutionPolicy: { kind: 'workflow', durability: 'required', providerRoute: 'server' },
            generationRequest: {
                job: { chatId: 'chat', jobType: 'model' },
                workflow: { workflowId: 'workflow', executionId: 'execution', stepKey: 'model', dependency: { placeholder } },
            },
        },
    })
    await pluginRuntime.providers.get('provider')!(providerArg)

    const [, sent] = bridge.nativeFetch.mock.lastCall!
    expect(sent.body).toBe(body)
    expect(sent.generationRequest.job).toMatchObject({ adapterKind: 'openai-compatible' })
    expect(sent.responseDecoder).toEqual({ adapterKind: 'openai-compatible', stream: true })
    expect(sent.generationRequest.workflow.dependency.placeholder).toBe(placeholder)
})

it('supports manager updates, discovery and token exchange without an active provider callback', async () => {
    DBState.db = {
        plugins: [{ name: 'current', version: '3.0', enabled: true, script: 'current source' }],
        pluginCustomStorage: {},
    } as any
    await loadPlugins()
    const api = bridge.apis[0]
    for (const url of [
        'https://update.rsyumi.workers.dev/provider-manager/version.json',
        'https://update.rsyumi.workers.dev/provider-manager/providers.json',
        'https://api.example/v1/models',
    ]) {
        await api.nativeFetch(url, { method: 'GET' })
        expect(bridge.nativeFetch.mock.lastCall).toEqual([url, expect.objectContaining({
            llmExecutionPolicy: { kind: 'ephemeral', durability: 'off', providerRoute: 'server' },
        })])
    }
    const body = 'grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=test'
    await api.nativeFetch('https://oauth2.googleapis.com/token', {
        method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body,
    })
    const [, options] = bridge.nativeFetch.mock.lastCall!
    expect(options.body).toBe(body)
    expect(new Headers(options.headers).get('content-type')).toBe('application/x-www-form-urlencoded')
    expect(options).not.toHaveProperty('generationRequest')
})

it.each([
    { body: 'text', encoded: '"text"', contentType: 'application/json', response: '{"value":1}', data: { value: 1 }, ok: true, rawResponse: false },
    { body: new URLSearchParams({ key: 'a b' }), encoded: 'key=a+b', contentType: 'application/x-www-form-urlencoded', response: 'binary', data: new TextEncoder().encode('binary'), ok: true, rawResponse: true },
    { body: undefined, encoded: '', contentType: 'application/json', response: 'not JSON', data: 'not JSON', ok: false, rawResponse: false },
])('preserves legacy risuFetch encoding and response behavior ($contentType, raw=$rawResponse)', async test => {
    DBState.db = {
        plugins: [{ name: 'current', version: '3.0', enabled: true, script: 'current source' }],
        pluginCustomStorage: {},
        imageGenerationPresets: [{ settings: { sdProvider: 'comfyui', comfyUiUrl: 'http://localhost:8188' } }],
        imageGenerationPresetId: 0,
    } as any
    await loadPlugins()
    bridge.nativeFetch.mockResolvedValueOnce(new Response(test.response, { status: 200 }))

    const result = await bridge.apis[0].risuFetch('http://localhost:8188/prompt', {
        body: test.body, rawResponse: test.rawResponse,
    })

    expect(result).toMatchObject({ ok: test.ok, status: 200, data: test.data })
    const [, options] = bridge.nativeFetch.mock.calls[0]
    expect(options.body).toBe(test.encoded)
    expect(new Headers(options.headers).get('content-type')).toBe(test.contentType)
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

it('does not register output chat listeners when replacer permission is denied', async () => {
    DBState.db = {
        plugins: [{ name: 'current', version: '3.0', enabled: true, script: 'current source' }],
        pluginCustomStorage: {},
    } as any
    await loadPlugins()
    const listener = vi.fn()
    vi.mocked(alertConfirm).mockResolvedValueOnce(false)

    await bridge.apis[0].addRisuChatListener('output', listener)

    expect(alertConfirm).toHaveBeenCalledOnce()
    expect(pluginRuntime.chatOutput.has(listener)).toBe(false)
})

it('shares replacer permission with output chat listeners and removes both on unload', async () => {
    DBState.db = {
        plugins: [{ name: 'current', version: '3.0', enabled: true, script: 'current source' }],
        pluginCustomStorage: {},
    } as any
    await loadPlugins()
    const api = bridge.apis[0]
    const replacer = vi.fn<ReplacerFunction>(messages => [...messages, { role: 'user', content: 'replaced' }])
    const listener = vi.fn()

    await api.addRisuReplacer('beforeRequest', replacer)
    await api.addRisuChatListener('output', listener)

    expect(alertConfirm).toHaveBeenCalledOnce()
    expect(await [...pluginRuntime.replacerbeforeRequest][0]([], 'model')).toEqual([{ role: 'user', content: 'replaced' }])
    const output = { char: {}, chat: {}, characterIndex: 0, chatIndex: 0, messageIndex: 0 }
    for (const registered of pluginRuntime.chatOutput) await registered(output as any)
    expect(listener).toHaveBeenCalledExactlyOnceWith(output)

    await loadV3Plugins([])

    expect(pluginRuntime.replacerbeforeRequest.has(replacer)).toBe(false)
    expect(pluginRuntime.chatOutput.has(listener)).toBe(false)
})

it('ignores plugin-list changes in lite writes while updating ordinary settings', async () => {
    const installed = [{ name: 'installed', version: '3.0', script: 'stored source', enabled: true }]
    DBState.db = {
        plugins: installed,
        modules: [],
        personas: [],
        pluginCustomStorage: {},
        temperature: 0.7,
    } as any
    await loadPlugins()

    bridge.apis[0].setDatabaseLite({
        plugins: [],
        temperature: 1.1,
    })

    expect(DBState.db.plugins).toEqual(installed)
    expect(DBState.db.temperature).toBe(1.1)

})

it('targets DOM event listeners to their elements and detaches them on remove or plugin unload', async () => {
    DBState.db = {
        plugins: [
            { name: 'current', version: '3.0', enabled: true, script: 'current source' },
            { name: 'other', version: '3.0', enabled: true, script: 'current source' },
        ],
        pluginCustomStorage: {},
    } as any
    await loadPlugins()
    const [api, otherApi] = bridge.apis
    const root = await api.getRootDocument()
    const otherRoot = await otherApi.getRootDocument()
    expect(root).toBeTruthy()
    expect(otherRoot).toBeTruthy()
    expect(alertConfirm).toHaveBeenCalledOnce()

    const body = root.querySelector('body')
    const parent = root.createElement('div')
    const first = root.createElement('div')
    const second = root.createElement('div')
    parent.setClassName('listener-parent')
    first.setClassName('listener-first')
    second.setClassName('listener-second')
    parent.appendChild(first)
    parent.appendChild(second)
    body.appendChild(parent)

    const firstNode = document.querySelector('.listener-first')!
    const secondNode = document.querySelector('.listener-second')!
    const parentListener = vi.fn()
    const firstListener = vi.fn()
    const secondListener = vi.fn()
    const rootListener = vi.fn()
    const scrollListener = vi.fn()
    await parent.addEventListener('click', parentListener)
    const firstListenerId = await first.addEventListener('click', firstListener)
    await second.addEventListener('click', secondListener)
    await root.addEventListener('click', rootListener)
    await root.addEventListener('scroll', scrollListener)
    document.dispatchEvent(new Event('scroll'))
    expect(scrollListener).toHaveBeenCalledOnce()

    second.removeEventListener('click', firstListenerId)
    otherRoot.removeEventListener('click', firstListenerId)

    firstNode.dispatchEvent(new MouseEvent('click', { bubbles: false }))
    expect(firstListener).toHaveBeenCalledOnce()
    expect(secondListener).not.toHaveBeenCalled()
    expect(parentListener).not.toHaveBeenCalled()
    expect(rootListener).not.toHaveBeenCalled()

    firstNode.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect(firstListener).toHaveBeenCalledTimes(2)
    expect(secondListener).not.toHaveBeenCalled()
    expect(parentListener).toHaveBeenCalledOnce()
    expect(rootListener).toHaveBeenCalledOnce()

    first.removeEventListener('mouseover', firstListenerId, true)
    firstNode.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect(firstListener).toHaveBeenCalledTimes(2)

    const unloadListener = vi.fn()
    await second.addEventListener('click', unloadListener)
    secondNode.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect(unloadListener).toHaveBeenCalledOnce()
    await loadV3Plugins([])
    secondNode.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    document.dispatchEvent(new Event('scroll'))
    expect(unloadListener).toHaveBeenCalledOnce()
    expect(scrollListener).toHaveBeenCalledOnce()
})

it('does not deliver delayed keyboard events after listener removal or plugin unload', async () => {
    DBState.db = {
        plugins: [{ name: 'current', version: '3.0', enabled: true, script: 'current source' }],
        pluginCustomStorage: {},
    } as any
    await loadPlugins()
    const api = bridge.apis[0]
    const root = await api.getRootDocument()
    const element = root.createElement('div')
    element.setClassName('delayed-listener-target')
    root.querySelector('body').appendChild(element)
    const node = document.querySelector('.delayed-listener-target')!

    vi.useFakeTimers()
    try {
        const removedListener = vi.fn()
        const removedId = await element.addEventListener('keydown', removedListener)
        node.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'a' }))
        element.removeEventListener('keydown', removedId)
        await vi.runAllTimersAsync()
        expect(removedListener).not.toHaveBeenCalled()

        const unloadedListener = vi.fn()
        await element.addEventListener('keydown', unloadedListener)
        node.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'b' }))
        await loadV3Plugins([])
        await vi.runAllTimersAsync()
        expect(unloadedListener).not.toHaveBeenCalled()
    } finally {
        vi.useRealTimers()
    }
})

it.each([true, false])('scopes main DOM permission decisions to the plugin source (%s)', async initialGrant => {
    DBState.db = {
        plugins: [{ name: 'current', version: '3.0', enabled: true, script: 'source A' }],
        pluginCustomStorage: {},
    } as any
    await loadPlugins()
    vi.mocked(alertConfirm).mockResolvedValueOnce(initialGrant)
    const firstResult = await bridge.apis.at(-1).getRootDocument()
    expect(Boolean(firstResult)).toBe(initialGrant)
    expect(alertConfirm).toHaveBeenCalledOnce()

    await loadPlugins()
    const unchangedResult = await bridge.apis.at(-1).getRootDocument()
    expect(Boolean(unchangedResult)).toBe(initialGrant)
    expect(alertConfirm).toHaveBeenCalledOnce()

    DBState.db.plugins[0].script = 'source B'
    await loadPlugins()
    expect(await bridge.apis.at(-1).getRootDocument()).toBeTruthy()
    expect(alertConfirm).toHaveBeenCalledTimes(2)
})

it('retains approvals and denials until permissions are reset', async () => {
    DBState.db = {
        plugins: [{ name: 'current', version: '3.0', enabled: true, script: 'current source' }],
        pluginCustomStorage: {},
    } as any
    await loadPlugins()
    const api = bridge.apis.at(-1)
    const dateNow = vi.spyOn(Date, 'now').mockReturnValue(10_000)
    const initialReplacer = vi.fn<ReplacerFunction>(messages => messages)
    await api.addRisuReplacer('beforeRequest', initialReplacer)
    expect(alertConfirm).toHaveBeenCalledOnce()
    api.removeRisuReplacer('beforeRequest', initialReplacer)

    dateNow.mockReturnValue(10_000 + 3 * 24 * 60 * 60 * 1000 + 1)
    const allowedListener = vi.fn()
    await api.addRisuChatListener('output', allowedListener)
    expect(alertConfirm).toHaveBeenCalledOnce()
    expect(pluginRuntime.chatOutput.has(allowedListener)).toBe(true)

    await resetAllPluginPermissions()
    vi.mocked(alertConfirm).mockResolvedValueOnce(false)

    const laterReplacer = vi.fn<ReplacerFunction>(messages => messages)
    await api.addRisuReplacer('beforeRequest', laterReplacer)
    expect(alertConfirm).toHaveBeenCalledTimes(2)
    expect(pluginRuntime.replacerbeforeRequest.has(laterReplacer)).toBe(false)
    expect(await api.requestPluginPermission('replacer')).toBe(false)
    expect(alertConfirm).toHaveBeenCalledTimes(2)

    await resetPluginPermission('current')
    expect(await api.requestPluginPermission('replacer')).toBe(true)
    expect(alertConfirm).toHaveBeenCalledTimes(3)
})

it('resets the installed code without clearing earlier code decisions', async () => {
    DBState.db = {
        plugins: [{ name: 'current', version: '3.0', enabled: true, script: 'source A' }],
        pluginCustomStorage: {},
    } as any
    await loadPlugins()
    await bridge.apis.at(-1).getRootDocument()
    expect(alertConfirm).toHaveBeenCalledOnce()

    DBState.db.plugins[0].script = 'source B'
    await loadPlugins()
    await bridge.apis.at(-1).getRootDocument()
    expect(alertConfirm).toHaveBeenCalledTimes(2)

    await resetPluginPermission('current')
    DBState.db.plugins[0].script = 'source A'
    await loadPlugins()
    await bridge.apis.at(-1).getRootDocument()

    expect(alertConfirm).toHaveBeenCalledTimes(2)

    DBState.db.plugins[0].script = 'source B'
    await loadPlugins()
    await bridge.apis.at(-1).getRootDocument()
    expect(alertConfirm).toHaveBeenCalledTimes(3)
})

it.each([true, false])('shares permission decisions by code and resets them for that code (%s)', async answer => {
    DBState.db = {
        plugins: [
            { name: 'first', version: '3.0', enabled: true, script: 'shared source' },
            { name: 'second', version: '3.0', enabled: true, script: 'shared source' },
            { name: 'different', version: '3.0', enabled: true, script: 'different source' },
        ],
        pluginCustomStorage: {},
    } as any
    await loadPlugins()
    const [first, second, different] = bridge.apis
    vi.mocked(alertConfirm).mockResolvedValueOnce(answer)

    await expect(Promise.all([
        first.requestPluginPermission('db'),
        second.requestPluginPermission('db'),
    ])).resolves.toEqual([answer, answer])
    expect(alertConfirm).toHaveBeenCalledOnce()
    expect(alertNormalWait).toHaveBeenCalledTimes(answer ? 0 : 1)

    await expect(different.requestPluginPermission('db')).resolves.toBe(true)
    expect(alertConfirm).toHaveBeenCalledTimes(2)

    await resetPluginPermission('first')
    await expect(second.requestPluginPermission('db')).resolves.toBe(true)
    await expect(first.requestPluginPermission('db')).resolves.toBe(true)
    await expect(different.requestPluginPermission('db')).resolves.toBe(true)
    expect(alertConfirm).toHaveBeenCalledTimes(3)
})

it('keeps denial guidance open until dismissed before serving the next permission dialog', async () => {
    DBState.db = {
        plugins: [{ name: 'current', version: '3.0', enabled: true, script: 'current source' }],
        pluginCustomStorage: {},
    } as any
    await loadPlugins()
    const api = bridge.apis[0]
    let showGuide!: () => void
    let closeGuide!: () => void
    const shown = new Promise<void>(resolve => { showGuide = resolve })
    const dismissed = new Promise<void>(resolve => { closeGuide = resolve })
    vi.mocked(alertNormalWait).mockImplementationOnce(() => {
        showGuide()
        return dismissed
    })
    vi.mocked(alertConfirm).mockResolvedValueOnce(false)
    let settled = false
    const denied = api.requestPluginPermission('db').then((answer: boolean) => {
        settled = true
        return answer
    })
    await shown
    const next = api.requestPluginPermission('mainDom')

    try {
        await expect(api.requestPluginPermission('db')).resolves.toBe(false)
        await new Promise(resolve => setTimeout(resolve, 0))
        expect(settled).toBe(false)
        expect(alertConfirm).toHaveBeenCalledOnce()
        expect(alertNormalWait).toHaveBeenCalledOnce()
    } finally {
        closeGuide()
    }

    await expect(denied).resolves.toBe(false)
    await expect(next).resolves.toBe(true)
    expect(alertConfirm).toHaveBeenCalledTimes(2)
})

it('binds permission to the script executed by the host before later database edits', async () => {
    DBState.db = {
        plugins: [{ name: 'current', version: '3.0', enabled: true, script: 'source A' }],
        pluginCustomStorage: {},
    } as any
    const plugin = DBState.db.plugins[0]
    await reloadV3Plugin(plugin)
    const originalHostApi = bridge.apis.at(-1)

    plugin.script = 'source B'
    await originalHostApi.getRootDocument()
    expect(alertConfirm).toHaveBeenCalledOnce()

    await reloadV3Plugin(plugin)
    await bridge.apis.at(-1).getRootDocument()
    expect(alertConfirm).toHaveBeenCalledTimes(2)
})
