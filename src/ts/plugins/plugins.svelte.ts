import { Buffer } from 'buffer'
import { get, writable } from "svelte/store";
import { language } from "../../lang";
import { getCurrentCharacter, getDatabase, setDatabase, setDatabaseLite } from "../storage/database.svelte";
import { alertConfirm, alertError } from "../alert";
import { selectSingleFile, sleep } from "../util";
import type { OpenAIChat } from "../process/index.svelte";
import { fetchNative, globalFetch, readImage, requestImmediateSave, saveAsset, toGetter } from "../globalApi.svelte";
import { DBState, pluginAlertModalStore, selectedCharID } from "../stores.svelte";
import type { ScriptMode } from "../process/scripts";
import { checkCodeSafety } from "./pluginSafety";
import { SafeDocument, SafeIdbFactory, SafeLocalStorage } from "./pluginSafeClass";
import { loadV3Plugins, reloadV3Plugin } from "./apiV3/v3.svelte";
import { pluginCodeTranspiler } from "./apiV3/transpiler";
import { pluginDisabledForMemorySession } from "./pluginMemorySafety";

export const customProviderStore = writable([] as string[])

const supportedPluginApiVersions = ['2.0', '2.1', '3.0'] as const
type DeclaredPluginApiVersion = typeof supportedPluginApiVersions[number]
type LegacyV2Version = 2 | '2.0' | '2.1'

function isSupportedPluginApiVersion(version: string): version is DeclaredPluginApiVersion {
    return supportedPluginApiVersions.some((supportedVersion) => supportedVersion === version)
}

function isLegacyV2Version(version: unknown): version is LegacyV2Version {
    return version === 2 || version === '2.0' || version === '2.1'
}

interface ProviderPlugin {
    name: string
    displayName?: string
    script: string
    arguments: { [key: string]: 'int' | 'string' | string[] }
    realArg: { [key: string]: number | string }
    version?: 1 | 2 | '2.1' | '3.0'
    customLink: ProviderPluginCustomLink[]
    argMeta: { [key: string]: {[key:string]:string} }
    versionOfPlugin?: string
    updateURL?: string
    enabled?: boolean
    allowedIPC?: string[]
}
interface ProviderPluginCustomLink {
    link: string
    hoverText?: string
}

export type RisuPlugin = ProviderPlugin
type LegacyV2Plugin = RisuPlugin & { version: 2 | '2.1' }

export function isLegacyV2Plugin(plugin: RisuPlugin): plugin is LegacyV2Plugin {
    return isLegacyV2Version(plugin.version)
}

export function getBlankPluginSource(){
    const plugins = getDatabase().plugins ?? []
    const names = new Set(plugins.map((plugin: RisuPlugin) => plugin.name))
    let suffix = 1
    let name = 'new_plugin'
    while(names.has(name)){
        suffix += 1
        name = `new_plugin_${suffix}`
    }

    return `//@name ${name}
//@display-name New Plugin
//@api 3.0

(async () => {
    Risuai.log("Hello from New Plugin!");
})();`
}

export async function createBlankPlugin(code = getBlankPluginSource()){
    return importPlugin(code)
}

const compareVersions = (v1: string, v2: string): 0|1|-1 => {
    const v1parts = v1.split('.').map(Number);
    const v2parts = v2.split('.').map(Number);
    const len = Math.max(v1parts.length, v2parts.length);
    for (let i = 0; i < len; i++) {
        const part1 = v1parts[i] || 0;
        const part2 = v2parts[i] || 0;
        if (part1 > part2) return 1;
        if (part1 < part2) return -1;
    }
    return 0;
}

const updateCache = new Map<string, { version: string, updateURL: string } | undefined>();

export const checkPluginUpdate = async (plugin: RisuPlugin) => {
    try {
        if(!plugin.updateURL){
            return
        }

        if(updateCache.has(plugin.name)){
            const cached = updateCache.get(plugin.name)
            if(compareVersions(cached.version, plugin.versionOfPlugin || '0.0.0') === 1){
                return cached
            }
        }

        const response = (await fetch(plugin.updateURL, {
            method: 'GET',
            headers: {
                'Range': 'bytes=0-512'
            }
        }))

        if(response.status >= 200 && response.status < 300){
            const text = await response.text()
            const versioRegex = /\/\/@version\s+([^\s]+)/;
            const match = text.match(versioRegex);
            if(match && match[1]){
                const latestVersion = match[1].trim()
                if(compareVersions(latestVersion, plugin.versionOfPlugin || '0.0.0') === 1){
                    updateCache.set(plugin.name, {
                        version: latestVersion,
                        updateURL: plugin.updateURL
                    })
                    return {
                        version: latestVersion,
                        updateURL: plugin.updateURL
                    }
                }
            }
        }
    } catch (error) {
        console.warn('Failed to check plugin update:', error)
    }
}

export async function updatePlugin(plugin: RisuPlugin) {
    try {
        if(!plugin.updateURL){
            return false
        }
        const response = await fetch(plugin.updateURL)
        if(response.status >= 200 && response.status < 300){
            const jsFile = await response.text()
            return importPlugin(jsFile, {
                isUpdate: true,
                originalPluginName: plugin.name
            })
        }
    } catch (error) {
        console.error('Failed to update plugin:', error)
    }
    return false
}

export async function importPlugin(code:string|null = null, argu:{
    isUpdate?: boolean
    originalPluginName?: string
    isTypescript?: boolean
} = {}): Promise<boolean> {
    try {
        let jsFile = ''
        const db = getDatabase()
        const isUpdate = argu.isUpdate || false
        const originalPluginName = argu.originalPluginName || ''
        let isTypescript = argu.isTypescript || false
        
        if(code === null){
            const f = await selectSingleFile(['js','ts'])
            if (!f) {
                return false
            }
            if(f.name.endsWith('.ts')){
                isTypescript = true
            }
            //support utf-8 with BOM or without BOM
            jsFile = Buffer.from(f.data).toString('utf-8').replace(/^\uFEFF/gm, "");
        }
        else{
            jsFile = code
        }

        const splitedJs = jsFile.split('\n')
        let name = ''
        for (const line of splitedJs) {
            if (line.startsWith('//@name')) {
                name = line.slice(7).trim()
                break
            }
        }

        const showError = (msg: string) => alertError(msg)

        let displayName: string = undefined
        let arg: { [key: string]: 'int' | 'string' | string[] } = {}
        let realArg: { [key: string]: number | string } = {}
        let argMeta: { [key: string]: {[key:string]:string} } = {}
        let customLink: ProviderPluginCustomLink[] = []
        let updateURL: string = ''
        let versionOfPlugin: string = '' //This is the version of the plugin itself, not the API version
        let apiVersion: DeclaredPluginApiVersion = '2.0'
        let ipcList: string[] = []
        for (const line of splitedJs) {
            if (line.startsWith('//@name')) {
                const provied = line.slice(7)
                if (provied === '') {
                    showError('plugin name must be longer than 0, did you put it correctly?')
                    return false
                }
                name = provied.trim()
            }
            if(line.startsWith('//@api')){
                const proviedVersions = line.slice(6).trim().split(' ')
                for(const ver of proviedVersions){
                    if(isSupportedPluginApiVersion(ver)){
                        apiVersion = ver
                        break
                    }
                    else{
                        console.warn(`Plugin API version "${ver}" is not supported.`)
                    }
                }
            }
            if (line.startsWith('//@display-name')) {
                const provied = line.slice('//@display-name'.length + 1)
                if (provied === '') {
                    showError('plugin display name must be longer than 0, did you put it correctly?')
                    return false
                }
                displayName = provied.trim()
            }

            if (line.startsWith('//@link')) {
                const link = line.split(" ")[1]
                if (!link || link === '') {
                    showError('plugin link is empty, did you put it correctly?')
                    return false
                }
                if (!link.startsWith('https')) {
                    showError('plugin link must start with https, did you check it?')
                    return false
                }
                const hoverText = line.split(' ').slice(2).join(' ').trim()
                if (hoverText === '') {
                    // OK, no hover text. It's fine.
                    customLink.push({
                        link: link,
                        hoverText: undefined
                    });
                }
                else
                    customLink.push({
                        link: link,
                        hoverText: hoverText || undefined
                    });
            }
            if (line.startsWith('//@risu-arg') || line.startsWith('//@arg')) {
                const provied = line.trim().split(' ')
                if (provied.length < 3) {
                    showError('plugin argument is incorrect, did you put space in argument name?')
                    return false
                }
                const provKey = provied[1]

                if (provied[2] !== 'int' && provied[2] !== 'string') {
                    showError(`plugin argument type is "${provied[2]}", which is an unknown type.`)
                    return false
                }
                if (provied[2] === 'int') {
                    arg[provKey] = 'int'
                    realArg[provKey] = 0
                }
                else if (provied[2] === 'string') {
                    arg[provKey] = 'string'
                    realArg[provKey] = ''
                }

                if(provied.length > 3){
                    const meta: {[key:string]:string} = {}
                    //Compatibility layer for unofficial meta
                    let metaStr = provied.slice(3).join(' ').replace(
                        /{{(.+?)(::?(.+?))?}}/g,
                        (a,g1:string,g2,g3:string) => {
                            console.log(g1,g3)
                            meta[g1] = g3 || '1'
                            return ''
                        }
                    ).trim()

                    if(metaStr){
                        meta['description'] = metaStr
                    }

                    argMeta[provKey] = meta
                }
            }

            if(line.startsWith('//@update-url')){
                updateURL = line.split(' ')[1]

                try {
                    const url = new URL(updateURL)
                    if(url.protocol !== 'https:'){
                        showError('plugin update URL must start with https, did you put it correctly?')
                        return false
                    }
                } catch (error) {
                    showError('plugin update URL is not a valid URL, did you put it correctly?')
                    return false
                }
            }

            if(line.startsWith('//@version')){
                versionOfPlugin = line.split(' ').slice(1).join(' ').trim()

                const versionLocation = jsFile.indexOf('//@version')
                const numberOfBytesBefore = new TextEncoder().encode(jsFile.slice(0, versionLocation) + line).length
                if(numberOfBytesBefore > 500){
                    showError('plugin version declaration must be within the first 512 Bytes of the file for proper parsing. move //@version line to the top of the file.')
                    return false
                }
            }

            if(line.startsWith('//@allowed-ipc')){
                const provied = line.trim().split(' ')
                if(provied.length < 2){
                    showError('plugin allowed IPC declaration is incorrect, did you put space after //@allowed-ipc?')
                    return false
                }

                const allowedIPCList = provied.slice(1)

                ipcList.push(...allowedIPCList)
            }
        }

        if (name.length === 0) {
            showError('plugin name not found, did you put it correctly?')
            return false
        }

        if(updateURL && versionOfPlugin.length === 0){
            showError('plugin version not found, did you put it correctly? It is required when update URL is provided.')
            return false
        }

        if(versionOfPlugin && compareVersions(versionOfPlugin, '0.0.1') === -1){
            showError('plugin version must be at least 0.0.1')
            return false
        }

        
        if(isTypescript){
            try {
                jsFile = await pluginCodeTranspiler(jsFile)                
            } catch (error) {
                showError('Failed to transpile TypeScript code: ' + (error instanceof Error ? error.message : String(error)))
                return false
            }
        }

        let apiInternalVersion: 2|'2.1'|'3.0' = '2.1'
        if(isLegacyV2Version(apiVersion) && !DBState.db.allowV2Plugin){
            showError(`Your plugin uses API version ${apiVersion}, which is outdated and no longer supported. Please update your plugin to use at least API version 3.0.`)
            return false
        }

        if(apiVersion === '2.1'){
            const safety = await checkCodeSafety(jsFile)
            if(!safety.isSafe){
                pluginAlertModalStore.errors = safety.errors
                pluginAlertModalStore.open = true
                
                //I can use event but lazy
                while(pluginAlertModalStore.open){
                    await sleep(100)
                }

                if(pluginAlertModalStore.errors.length > 0){
                    return false
                }
            }
            apiInternalVersion = '2.1'
        }
        else if(apiVersion === '2.0'){
            apiInternalVersion = 2
        }
        else if(apiVersion === '3.0'){
            apiInternalVersion = '3.0'
        }

        let pluginData: RisuPlugin = {
            name: name,
            script: jsFile,
            realArg: realArg,
            arguments: arg,
            displayName: displayName,
            version: apiInternalVersion,
            customLink: customLink,
            argMeta: argMeta,
            versionOfPlugin: versionOfPlugin,
            updateURL: updateURL,
            allowedIPC: ipcList,
            enabled: true
        }

        db.plugins ??= []

        const oldPluginIndex = db.plugins.findIndex((p: RisuPlugin) => p.name === pluginData.name);
        const oldPlugin: RisuPlugin | undefined = oldPluginIndex !== -1 ? db.plugins[oldPluginIndex] : undefined;

        if(originalPluginName && originalPluginName !== pluginData.name){
            showError(`When updating plugin "${originalPluginName}", the plugin name cannot be changed to "${pluginData.name}". Please keep the original name to update.`)
            return false
        }

        if(!isUpdate && oldPlugin){
            const c = await alertConfirm(language.duplicatePluginFoundUpdateIt)
            if(!c){
                return false
            }
        }

        if(oldPlugin){
            // Updating code must not discard user-owned configuration.
            for(const key of Object.keys(arg)){
                if(oldPlugin.arguments?.[key] === arg[key] && oldPlugin.realArg && key in oldPlugin.realArg){
                    pluginData.realArg[key] = oldPlugin.realArg[key]
                }
            }
            if(isUpdate) pluginData.enabled = oldPlugin.enabled ?? true
            db.plugins[oldPluginIndex] = pluginData;
        }
        else if(!isUpdate){
            db.plugins.push(pluginData)
        }

        console.log(`Imported plugin: ${pluginData.name} (API v${apiVersion})`)
        setDatabaseLite(db)
        void requestImmediateSave()

        if(isUpdate && oldPlugin?.version === '3.0' && pluginData.version === '3.0' && !pluginDisabledForMemorySession(pluginData)){
            await reloadV3Plugin(pluginData)
        }
        else{
            await loadPlugins()
        }
        return true
        
    } catch (error) {
        console.error(error)
        alertError(language.errors.noData)
        return false
    }
}

let pluginTranslator = false

export async function loadPlugins() {
    console.log('Loading plugins...')
    const db = getDatabase()

    // The legacy API permission is also the source of truth for each plugin's
    // power state. Keep legacy plugins off until the user explicitly allows
    // the API and then enables individual plugins again.
    let disabledLegacyPlugin = false
    if(!db.allowV2Plugin){
        for(const plugin of db.plugins ?? []){
            if(isLegacyV2Plugin(plugin) && plugin.enabled){
                plugin.enabled = false
                disabledLegacyPlugin = true
            }
        }
    }
    if(disabledLegacyPlugin){
        void requestImmediateSave()
    }

    // addProvider registrations are rebuilt from enabled plugins on every load.
    // Clear the display list with the provider maps so disabled/hot-reloaded
    // plugins cannot leave duplicate or stale models in either model picker.
    customProviderStore.set([])

    const enabledPlugins = structuredClone((db.plugins ?? []).filter((p: RisuPlugin) => (
        p.enabled && !pluginDisabledForMemorySession(p)
    )))
    const pluginV2 = enabledPlugins.filter(isLegacyV2Plugin)
    const pluginV3 = enabledPlugins.filter((a: RisuPlugin) => a.version === '3.0')

    await loadV2Plugin(pluginV2)
    await loadV3Plugins(pluginV3)
}

// Host-only metadata for API 3.0 addProvider dispatch. This symbol is removed
// by structured cloning before provider code enters the sandbox.
export const pluginProviderRequestContextKey: unique symbol = Symbol('pluginProviderRequestContext')

export type PluginProviderRequestContext = {
    chatId?: string
    generationRequest?: import('../process/revenant').RevenantGenerationRequest
    llmExecutionPolicy?: import('../network/transportTypes').LLMExecutionPolicy
    interceptor: string
}

export type PluginV2ProviderArgument = {
    prompt_chat: OpenAIChat[]
    frequency_penalty: number
    min_p: number
    presence_penalty: number
    repetition_penalty: number
    top_k: number
    top_p: number
    temperature: number
    mode: string
    max_tokens: number
    [pluginProviderRequestContextKey]?: PluginProviderRequestContext
}

export type PluginV2ProviderOptions = {
    tokenizer?: string
    tokenizerFunc?: (content: string) => number[] | Promise<number[]>
}

export type EditFunction = (content: string) => string | null | undefined | Promise<string | null | undefined>
type ReplacerFunction = (content: OpenAIChat[], type: string) => OpenAIChat[] | Promise<OpenAIChat[]>
export type ChatOutputListenerArg = {
    char: any
    chat: any
    characterIndex: number
    chatIndex: number
    messageIndex: number
}
type ChatOutputListener = (arg: ChatOutputListenerArg) => void | Promise<void>

export const pluginV2 = {
    providers: new Map<string, (arg: PluginV2ProviderArgument, abortSignal?: AbortSignal) => Promise<{ success: boolean, content: string | ReadableStream<string> }>>(),
    providerOptions: new Map<string, PluginV2ProviderOptions>(),
    editdisplay: new Set<EditFunction>(),
    editoutput: new Set<EditFunction>(),
    editprocess: new Set<EditFunction>(),
    editinput: new Set<EditFunction>(),
    replacerbeforeRequest: new Set<ReplacerFunction>(),
    replacerafterRequest: new Set<(content: string, type: string) => string | Promise<string>>(),
    chatOutput: new Set<ChatOutputListener>(),
    unload: new Set<() => void | Promise<void>>(),
    loaded: false
}

export const allowedDbKeys = [
    'characters',
    'modules',
    'enabledModules',
    'moduleIntergration',
    'pluginV2',
    'personas',
    'plugins',
    'pluginCustomStorage',
    'temperature',
    'maxContext',
    'maxResponse',
    'frequencyPenalty',
    'PresensePenalty',
    'theme',
    'textTheme',
    'lineHeight',
    'seperateModelsForAxModels',
    'seperateModels',
    'customCSS',
    'guiHTML',
    'colorSchemeName',
    'selectedPersona',
    'characterOrder'
]

export const getV2PluginAPIs = () => {
    return {
        risuFetch: globalFetch,
        nativeFetch: fetchNative,
        getArg: (arg: string) => {
            const db = getDatabase()
            const [name, realArg] = arg.split('::')
            for (const plugin of db.plugins) {
                if (plugin.name === name) {
                    return plugin.realArg[realArg]
                }
            }
        },
        getChar: () => {
            return getCurrentCharacter({ snapshot: true })
        },
        setChar: (char: any) => {
            const db = getDatabase()
            const charid = get(selectedCharID)
            db.characters[charid] = char
            setDatabaseLite(db)
        },
        addProvider: (name: string, func: (arg: PluginV2ProviderArgument, abortSignal?: AbortSignal) => Promise<{ success: boolean, content: string }>, options?: PluginV2ProviderOptions) => {
            let provs = get(customProviderStore)
            provs.push(name)
            pluginV2.providers.set(name, func)
            pluginV2.providerOptions.set(name, options ?? {})
            customProviderStore.set(provs)
        },
        addRisuScriptHandler: (name: ScriptMode, func: EditFunction) => {
            if (pluginV2['edit' + name]) {
                pluginV2['edit' + name].add(func)
            }
            else {
                throw (`script handler named ${name} not found`)
            }
        },
        removeRisuScriptHandler: (name: ScriptMode, func: EditFunction) => {
            if (pluginV2['edit' + name]) {
                pluginV2['edit' + name].delete(func)
            }
            else {
                throw (`script handler named ${name} not found`)
            }
        },
        addRisuReplacer: (name: string, func: ReplacerFunction) => {
            if (pluginV2['replacer' + name]) {
                pluginV2['replacer' + name].add(func)
            }
            else {
                throw (`replacer handler named ${name} not found`)
            }
        },
        removeRisuReplacer: (name: string, func: ReplacerFunction) => {
            if (pluginV2['replacer' + name]) {
                pluginV2['replacer' + name].delete(func)
            }
            else {
                throw (`replacer handler named ${name} not found`)
            }
        },
        addRisuChatListener: (mode: string, func: ChatOutputListener) => {
            if(mode !== 'output') throw (`chat listener mode ${mode} not found`)
            pluginV2.chatOutput.add(func)
        },
        removeRisuChatListener: (mode: string, func: ChatOutputListener) => {
            if(mode !== 'output') throw (`chat listener mode ${mode} not found`)
            pluginV2.chatOutput.delete(func)
        },
        onUnload: (func: () => void | Promise<void>) => {
            pluginV2.unload.add(func)
        },
        setArg: (arg: string, value: string | number) => {
            const db = getDatabase();
            const [name, realArg] = arg.split("::");
            for (const plugin of db.plugins) {
                if (plugin.name === name) {
                    plugin.realArg[realArg] = value;
                }
            }
        },
        safeGlobalThis: {} as any,
        getSafeGlobalThis: () => {
            if(Object.keys(globalThis.__pluginApis__.safeGlobalThis).length > 0){
                return globalThis.__pluginApis__.safeGlobalThis;
            }
            //safeGlobalThis
            const keys = Object.keys(globalThis);
            const safeGlobal: any = {};
            const allowedKeys = [
                'console',
                'TextEncoder',
                'TextDecoder',
                'URL',
                'URLSearchParams',
            ]
            for (const key of keys) {
                if(allowedKeys.includes(key)){
                    safeGlobal[key] = (globalThis as any)[key];
                }
            }

            //compatibility layer with old unsafe APIs

            //from PBV2
            safeGlobal.showDirectoryPicker = globalThis.showDirectoryPicker

            safeGlobal.DBState = {
                db: toGetter(
                    globalThis.__pluginApis__.getDatabase
                )
            }
            safeGlobal.setInterval = (...args: any[]) => {
                //@ts-expect-error spreading any[] into setInterval params causes type mismatch with TimerHandler signature
                return globalThis.setInterval(...args);
            }
            safeGlobal.setTimeout = (...args: any[]) => {
                //@ts-expect-error spreading any[] into setTimeout params causes type mismatch with TimerHandler signature
                return globalThis.setTimeout(...args);
            }
            safeGlobal.clearInterval = (...args: any[]) => {
                //@ts-expect-error spreading any[] into clearInterval - first arg should be number | undefined
                return globalThis.clearInterval(...args);
            }
            safeGlobal.clearTimeout = (...args: any[]) => {
                //@ts-expect-error spreading any[] into clearTimeout - first arg should be number | undefined
                return globalThis.clearTimeout(...args);
            }
            safeGlobal.alert = globalThis.alert;
            safeGlobal.confirm = globalThis.confirm;
            safeGlobal.prompt = globalThis.prompt;
            safeGlobal.innerWidth = window.innerWidth;
            safeGlobal.innerHeight = window.innerHeight;
            safeGlobal.getComputedStyle = window.getComputedStyle
            safeGlobal.navigator = window.navigator;
            safeGlobal.localStorage = globalThis.__pluginApis__.safeLocalStorage;
            safeGlobal.indexedDB = globalThis.__pluginApis__.safeIdbFactory;
            safeGlobal.__pluginApis__ = globalThis.__pluginApis__
            safeGlobal.Object = Object;
            safeGlobal.Array = Array;
            safeGlobal.String = String;
            safeGlobal.Number = Number;
            safeGlobal.Boolean = Boolean;
            safeGlobal.Math = Math;
            safeGlobal.Date = Date;
            safeGlobal.RegExp = RegExp;
            safeGlobal.Error = Error;
            safeGlobal.Function = globalThis.__pluginApis__.SafeFunction;
            safeGlobal.document = globalThis.__pluginApis__.safeDocument;
            safeGlobal.addEventListener = (...args: any[]) => {
                //@ts-expect-error spreading any[] into addEventListener - expects (type: string, listener: EventListenerOrEventListenerObject, options?: boolean | AddEventListenerOptions)
                window.addEventListener(...args);
            }
            safeGlobal.removeEventListener = (...args: any[]) => {
                //@ts-expect-error spreading any[] into removeEventListener - expects (type: string, listener: EventListenerOrEventListenerObject, options?: boolean | EventListenerOptions)
                window.removeEventListener(...args);
            }
            return safeGlobal;
        },
        safeLocalStorage: new SafeLocalStorage(),
        safeIdbFactory: SafeIdbFactory,
        safeDocument: SafeDocument,
        alertStore: {
            set: (msg: string) => {}
        },
        apiVersion: "2.1",
        apiVersionCompatibleWith: ["2.0","2.1"],
        getDatabase: () => {
            const db = DBState?.db
            if(!db){
                return {}
            }
            return new Proxy(db, {
                get(target, prop) {
                    if (typeof prop === 'string' && allowedDbKeys.includes(prop)) {
                        return (target as any)[prop];
                    }
                    else if(target.pluginCustomStorage){
                        console.log('Getting custom db property', prop.toString());
                        return target.pluginCustomStorage[prop.toString()];
                    }
                    return undefined;
                },
                set(target, prop, value) {
                    if (typeof prop === 'string' && allowedDbKeys.includes(prop)) {
                        (target as any)[prop] = value;
                        return true;
                    }
                    else{
                        console.log('Setting custom db property', prop.toString(), value);
                        target.pluginCustomStorage ??= {}
                        target.pluginCustomStorage[prop.toString()] = value;
                        return true;
                    }
                },
                ownKeys(target) {
                    const keys = Reflect.ownKeys(target).filter(key => typeof key === 'string' && allowedDbKeys.includes(key));
                    if(target.pluginCustomStorage){
                        keys.push(...Object.keys(target.pluginCustomStorage));
                    }
                    return keys;
                },
                deleteProperty(target, prop) {
                    console.log('Attempt to delete db.' + String(prop) + ' denied in safe database proxy.');
                    return false;
                },
                getPrototypeOf(target) {
                    return Reflect.getPrototypeOf(target);
                },
            })
        },
        pluginStorage: {
            getItem: (key: string) => {
                const db = getDatabase({ snapshot: true });
                db.pluginCustomStorage ??= {}
                return db.pluginCustomStorage[key] || null;
            },
            setItem: (key: string, value: string) => {
                const db = getDatabase();
                db.pluginCustomStorage ??= {}
                db.pluginCustomStorage[key] = value;
            },
            removeItem: (key: string) => {
                const db = getDatabase();
                db.pluginCustomStorage ??= {}
                delete db.pluginCustomStorage[key];
            },
            clear: () => {
                const db = getDatabase();
                db.pluginCustomStorage = {};
            },
            key: (index: number) => {
                const db = getDatabase();
                db.pluginCustomStorage ??= {}
                const keys = Object.keys(db.pluginCustomStorage);
                return keys[index] || null;
            },
            keys: () => {
                const db = getDatabase();
                db.pluginCustomStorage ??= {}
                return Object.keys(db.pluginCustomStorage);
            },
            length: () => {
                const db = getDatabase();
                db.pluginCustomStorage ??= {}
                return Object.keys(db.pluginCustomStorage).length;
            }
        },
        setDatabaseLite: (newDb: any) => {
            const db = getDatabase();
            db.pluginCustomStorage ??= {}
            for (const key of Object.keys(newDb)) {
                if (allowedDbKeys.includes(key)) {
                    (db as any)[key] = newDb[key];
                }
                else{
                    db.pluginCustomStorage[key] = newDb[key];
                }
            }
            DBState.db = db;
        },
        setDatabase: async (newDb: any) => {
            const db = getDatabase();
            db.pluginCustomStorage ??= {}
            for (const key of Object.keys(newDb)) {
                if (key === 'plugins') {
                    console.warn('[WARN] Plugin attempted to access plugin directly. this would be blocked in future versions. Instead, use the provided APIs to manage plugins. Attempting to handle plugin installation via plugin for new plugins in the provided database object.')
                    newDb[key] = await handlePluginInstallViaPlugin(newDb.plugins)
                }
                
                if (allowedDbKeys.includes(key)) {
                    (db as any)[key] = newDb[key];
                }
                else{
                    db.pluginCustomStorage[key] = newDb[key];
                }
            }
            setDatabase(db);
        },
        SafeFunction: new Proxy(Function, {
            construct(target, args) {
                return function() {
                    return globalThis.__pluginApis__.getSafeGlobalThis();
                }
            },
            
            //call too
            apply(target, thisArg, args) {
                return function() {
                    return globalThis.__pluginApis__.getSafeGlobalThis();
                }
            }

        }),
        loadPlugins: loadPlugins,
        readImage: (path:string) => {
            if(path.startsWith('assets/')){
                //trim assets/ prefix temporarily
                path = path.slice(7);
            }
            if(path.includes('/') || path.includes('\\')){
                throw new Error("readImage path cannot contain '/' or '\\' for security reasons, except assets/ prefix.");
            }
            //re-add assets/ prefix
            return readImage('assets/' + path);
        },
        saveAsset: (data:Uint8Array) => {
            return saveAsset(data);
        },

    }
}

export async function loadV2Plugin(plugins: LegacyV2Plugin[]) {

    if (pluginV2.loaded) {
        for (const unload of pluginV2.unload) {
            await unload()
        }

        pluginV2.providers.clear()
        pluginV2.providerOptions.clear()
        pluginV2.editdisplay.clear()
        pluginV2.editoutput.clear()
        pluginV2.editprocess.clear()
        pluginV2.editinput.clear()
        pluginV2.chatOutput.clear()
    }

    pluginV2.loaded = true

    globalThis.__pluginApis__ = getV2PluginAPIs()

    for (const plugin of plugins) {
        let data: string
        const version = plugin.version

        const createRealScript = (source:string): string => {
            const tt = (window as unknown as Window & {
                trustedTypes?: {
                    createPolicy: (name: string, rules: { createScript: (input: string) => string }) => { createScript: (input: string) => string }
                }
            }).trustedTypes
            const policyFactory = tt ?? {
                createPolicy: (_name: string, rules: { createScript: (input: string) => string }) => rules // Just return the rules object as the "policy"
            }

            const policy = policyFactory.createPolicy('plugin-policy', {
                createScript: (input) => {
                    return `(async () => {
                        const risuFetch = globalThis.__pluginApis__.risuFetch
                        const nativeFetch = globalThis.__pluginApis__.nativeFetch
                        const getArg = globalThis.__pluginApis__.getArg
                        const printLog = globalThis.__pluginApis__.printLog
                        const getChar = globalThis.__pluginApis__.getChar
                        const setChar = globalThis.__pluginApis__.setChar
                        const addProvider = globalThis.__pluginApis__.addProvider
                        const addRisuScriptHandler = globalThis.__pluginApis__.addRisuScriptHandler
                        const removeRisuScriptHandler = globalThis.__pluginApis__.removeRisuScriptHandler
                        const addRisuReplacer = globalThis.__pluginApis__.addRisuReplacer
                        const removeRisuReplacer = globalThis.__pluginApis__.removeRisuReplacer
                        const onUnload = globalThis.__pluginApis__.onUnload
                        const setArg = globalThis.__pluginApis__.setArg
                        const saveAsset = globalThis.__pluginApis__.saveAsset
                        const readImage = globalThis.__pluginApis__.readImage
                        ${version === '2.1' ? `
                            const safeGlobalThis = globalThis.__pluginApis__.getSafeGlobalThis()
                            const Risuai = globalThis.__pluginApis__
                            const safeLocalStorage = globalThis.__pluginApis__.safeLocalStorage
                            const safeIdbFactory = globalThis.__pluginApis__.safeIdbFactory
                            const alertStore = globalThis.__pluginApis__.alertStore
                            const safeDocument = globalThis.__pluginApis__.safeDocument
                            const getDatabase = globalThis.__pluginApis__.getDatabase
                            const setDatabaseLite = globalThis.__pluginApis__.setDatabaseLite
                            const setDatabase = globalThis.__pluginApis__.setDatabase
                            const loadPlugins = globalThis.__pluginApis__.loadPlugins
                            const SafeFunction = globalThis.__pluginApis__.SafeFunction
                        ` : ''}

                        ${input}
                    })();`
                }
            });

            return policy.createScript(source);
        }

        if(version === '2.1'){
            const safety = await checkCodeSafety(plugin.script)
            data = safety.modifiedCode
            console.log('Safety check result:', safety)
            console.log('Loading V2.1 Plugin', plugin.name, data)
        }
        else{
            data = plugin.script
            console.log('Loading V2.0 Plugin', plugin.name)
        }

        try {
            new Function(createRealScript(data))()
        } catch (error) {
            console.error(error)
        }

        if(version === '2.1'){
            console.log('Loaded V2.1 Plugin', plugin.name)
        }
        else{
            console.warn(`Plugin 2.0 support is deprecated. Please update plugin "${plugin.name}" to API version 3.0`)
        }
    }
}

export async function translatorPlugin(text: string, from: string, to: string) {
    return false
}

export async function pluginProcess(arg: {
    prompt_chat: OpenAIChat,
    temperature: number,
    max_tokens: number,
    presence_penalty: number
    frequency_penalty: number
    bias: { [key: string]: string }
} | {}) {
    return {
        success: false,
        content: language.pluginProviderNotFound
    }
}

export async function handlePluginInstallViaPlugin(plugins: RisuPlugin[]){

    const trimmedPlugins: RisuPlugin[] = []
    for(const plugin of plugins){
        if(!DBState.db.plugins.find((p: RisuPlugin) => p.name === plugin.name && p.script === plugin.script)){

            if(plugin.version !== '3.0'){
                console.warn(`Plugin "${plugin.name}" has version "${plugin.version}", which is not supported for installation via plugin. Only API version 3.0 plugins can be installed via plugin. Skipping installation of this plugin.`)
                continue
            }
            const confirmation = await alertConfirm(language.confirmInstallPluginViaPlugin.replace('{plugin}', plugin.name))
            if(confirmation){
                trimmedPlugins.push(plugin)
            }
        }
        else{
            console.warn(`Plugin "${plugin.name}" already exists, skipping installation via plugin.`)
        }
    }

    return trimmedPlugins
}
