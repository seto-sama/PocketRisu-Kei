import { Buffer } from 'buffer'
import { language } from '../../lang'
import { getDatabase, setDatabaseLite } from '../storage/database.svelte'
import { alertConfirm, alertError } from '../alert'
import { selectSingleImportFile } from '../util'
import { requestImmediateSave } from '../globalApi.svelte'
import { DBState } from '../stores.svelte'
import { loadV3Plugins, reloadV3Plugin } from './apiV3/v3.svelte'
import { pluginCodeTranspiler } from './apiV3/transpiler'
import { pluginDisabledForMemorySession } from './pluginMemorySafety'

const supportedPluginApiVersion = '3.0'

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
export function isSupportedPlugin(plugin: { version?: unknown }): boolean {
    return plugin.version === supportedPluginApiVersion
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
            const f = await selectSingleImportFile()
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
        const showError = (msg: string) => alertError(msg)

        let displayName: string = undefined
        let arg: { [key: string]: 'int' | 'string' | string[] } = {}
        let realArg: { [key: string]: number | string } = {}
        let argMeta: { [key: string]: {[key:string]:string} } = {}
        let customLink: ProviderPluginCustomLink[] = []
        let updateURL: string = ''
        let versionOfPlugin: string = '' //This is the version of the plugin itself, not the API version
        let apiVersion: string | undefined
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
                const versions = line.slice(6).trim().split(/\s+/)
                apiVersion = versions.includes(supportedPluginApiVersion) ? supportedPluginApiVersion : undefined
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
                customLink.push({ link, hoverText: hoverText || undefined });
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
                            if (import.meta.env.DEV) {
                                console.log(g1,g3)
                            }
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

        
        if (apiVersion !== supportedPluginApiVersion) {
            showError(language.pluginApiUnsupported)
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

        let pluginData: RisuPlugin = {
            name: name,
            script: jsFile,
            realArg: realArg,
            arguments: arg,
            displayName: displayName,
            version: supportedPluginApiVersion,
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

        if (import.meta.env.DEV) {
            console.log(`Imported plugin: ${pluginData.name} (API v${apiVersion})`)
        }
        setDatabaseLite(db)
        void requestImmediateSave()

        if(isUpdate && oldPlugin && isSupportedPlugin(oldPlugin) && pluginData.enabled && !pluginDisabledForMemorySession(pluginData)){
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

export async function loadPlugins() {
    const plugins = (getDatabase().plugins ?? []).filter(plugin => (
        isSupportedPlugin(plugin) && plugin.enabled && !pluginDisabledForMemorySession(plugin)
    ))
    await loadV3Plugins($state.snapshot(plugins))
}

export async function handlePluginInstallViaPlugin(plugins: RisuPlugin[]){

    const trimmedPlugins: RisuPlugin[] = []
    for(const plugin of plugins){
        if(!(DBState.db.plugins ?? []).find((p: RisuPlugin) => p.name === plugin.name && p.script === plugin.script)){

            if(!isSupportedPlugin(plugin)){
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
