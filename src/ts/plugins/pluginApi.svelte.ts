import { get } from 'svelte/store'
import { getCurrentCharacter, getDatabase, setDatabase, setDatabaseLite } from '../storage/database.svelte'
import { initializeChatSelection, withChatSelection } from '../storage/chatSelection.svelte'
import { fetchNative, globalFetch, readImage, saveAsset } from '../globalApi.svelte'
import { DBState, selectedCharID } from '../stores.svelte'
import type { ScriptMode } from '../process/scripts'
import { SafeLocalStorage } from './pluginSafeClass'
import { pluginRuntime, type EditFunction, type ReplacerFunction, type ChatOutputListener } from './pluginRuntime'
import { handlePluginInstallViaPlugin, loadPlugins } from './plugins.svelte'

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

function applyDatabaseWrite(newDb: Record<string, any>) {
    newDb.characters?.forEach(character => initializeChatSelection(character, true))
    const db = getDatabase()
    db.pluginCustomStorage ??= {}
    for (const key of Object.keys(newDb)) {
        if (allowedDbKeys.includes(key)) {
            (db as any)[key] = newDb[key]
        } else {
            db.pluginCustomStorage[key] = newDb[key]
        }
    }
    return db
}

export const createPluginApis = (pluginName: string) => {
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
            return withChatSelection(getCurrentCharacter({ snapshot: true }))
        },
        setChar: (char: any) => {
            initializeChatSelection(char, true)
            const db = getDatabase()
            const charid = get(selectedCharID)
            db.characters[charid] = char
            setDatabaseLite(db)
        },
        addRisuScriptHandler: (name: ScriptMode, func: EditFunction) => {
            if (pluginRuntime['edit' + name]) {
                pluginRuntime['edit' + name].add(func)
            }
            else {
                throw (`script handler named ${name} not found`)
            }
        },
        removeRisuScriptHandler: (name: ScriptMode, func: EditFunction) => {
            if (pluginRuntime['edit' + name]) {
                pluginRuntime['edit' + name].delete(func)
            }
            else {
                throw (`script handler named ${name} not found`)
            }
        },
        addRisuReplacer: (name: string, func: ReplacerFunction) => {
            if (pluginRuntime['replacer' + name]) {
                pluginRuntime['replacer' + name].add(func)
            }
            else {
                throw (`replacer handler named ${name} not found`)
            }
        },
        removeRisuReplacer: (name: string, func: ReplacerFunction) => {
            if (pluginRuntime['replacer' + name]) {
                pluginRuntime['replacer' + name].delete(func)
            }
            else {
                throw (`replacer handler named ${name} not found`)
            }
        },
        addRisuChatListener: (mode: string, func: ChatOutputListener) => {
            if(mode !== 'output') throw (`chat listener mode ${mode} not found`)
            pluginRuntime.chatOutput.add(func)
        },
        removeRisuChatListener: (mode: string, func: ChatOutputListener) => {
            if(mode !== 'output') throw (`chat listener mode ${mode} not found`)
            pluginRuntime.chatOutput.delete(func)
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
        safeLocalStorage: new SafeLocalStorage(pluginName),
        pluginStorage: {
            getItem: (key: string) => {
                return $state.snapshot(getDatabase().pluginCustomStorage?.[key]) ?? null;
            },
            setItem: (key: string, value: string) => {
                const db = getDatabase();
                db.pluginCustomStorage ??= {}
                db.pluginCustomStorage[key] = value;
            },
            removeItem: (key: string) => {
                delete getDatabase().pluginCustomStorage?.[key];
            },
            clear: () => {
                const db = getDatabase();
                db.pluginCustomStorage = {};
            },
            key: (index: number) => {
                return Object.keys(getDatabase().pluginCustomStorage ?? {})[index] ?? null;
            },
            keys: () => {
                return Object.keys(getDatabase().pluginCustomStorage ?? {});
            },
            length: () => {
                return Object.keys(getDatabase().pluginCustomStorage ?? {}).length;
            }
        },
        setDatabaseLite: (newDb: any) => {
            DBState.db = applyDatabaseWrite(newDb)
        },
        setDatabase: async (newDb: any) => {
            if (Object.hasOwn(newDb, 'plugins')) {
                const approvedPlugins = await handlePluginInstallViaPlugin(newDb.plugins)
                const mergedPlugins = [...(getDatabase().plugins ?? [])]
                for (const approved of approvedPlugins) {
                    const index = mergedPlugins.findIndex(plugin => plugin.name === approved.name)
                    if (index !== -1) {
                        mergedPlugins[index] = approved
                    } else {
                        mergedPlugins.push(approved)
                    }
                }
                newDb.plugins = mergedPlugins
            }
            setDatabase(applyDatabaseWrite(newDb))
        },
        loadPlugins: loadPlugins,
        readImage: (path:string) => {
            if(path.startsWith('assets/')){
                path = path.slice(7);
            }
            if(path.includes('/') || path.includes('\\')){
                throw new Error("readImage path cannot contain '/' or '\\' for security reasons, except assets/ prefix.");
            }
            return readImage('assets/' + path);
        },
        saveAsset: (data:Uint8Array) => {
            return saveAsset(data);
        },

    }
}
