import { Buffer } from 'buffer'
import { language } from "src/lang"
import { alertClear, alertConfirm, alertError, alertModuleSelect, alertNormal, alertWait, notifySuccess } from "../alert"
import { getCurrentCharacter, getCurrentChat, getDatabase, setCurrentCharacter, setDatabase, type character, type Chat, type customscript, type loreBook, type triggerscript } from "../storage/database.svelte"
import { AppendableBuffer, forageStorage, readImage, saveAsset } from "../globalApi.svelte"
import { checkPersonaBinded, selectSingleImportFile, sleep } from "../util"
import { createEntityId } from "../id"
import { convertExternalLorebook } from "./lorebook.svelte"
import { compressImage } from '../media'
import { decodeRPack, encodeRPack } from "../rpack/rpack_js"
import { HideIconStore, moduleBackgroundEmbedding } from "../stores.svelte"
import {get} from "svelte/store"
import { convertCharacterToModule, convertModuleToCharacter } from "../interchangeability"
import { exportCharacterCard, importCharacterProcess } from "../characterCards"
import { readDefaultAvatarImage } from "../avatarImage"
import { normalizePresetTagFields, type PresetTagFields } from "../preset/tags"
import { exportPresetFile, showExportAssetProgress } from "../preset/export"
import { getEnabledModules } from './moduleSelection'

export interface MCPModule{
    url: string
}

export interface RisuModule extends PresetTagFields {
    name: string
    description: string
    lorebook?: loreBook[]
    imageTagBundleLorebookId?: string
    regex?: customscript[]
    cjs?: string
    trigger?: triggerscript[]
    id: string
    lowLevelAccess?: boolean
    hideIcon?: boolean
    backgroundEmbedding?:string
    assets?:[string,string,string][]
    namespace?:string
    customModuleToggle?:string
    mcp?:MCPModule
    icon?:string
}

export async function exportModule(module:RisuModule){
    const moduleName = module.name
    const char = convertModuleToCharacter(module)
    if(!char.image){
        char.image = await saveAsset(await readDefaultAvatarImage())
        char.extentions ??= {}
        char.extentions['moduleNoneImage'] = true
    }
    await exportCharacterCard(char, 'charx', {
        spec: 'v3',
        fileName: `${moduleName}.module.charx`
    })
}

export async function encodeModuleLegacy(
    module:RisuModule,
    onProgress?:(completed:number, total:number) => void
):Promise<Uint8Array>{
    const apb = new AppendableBuffer()
    const writeLength = (len:number) => {
        const lenbuf = Buffer.alloc(4)
        lenbuf.writeUInt32LE(len, 0)
        apb.append(lenbuf)
    }
    const writeByte = (byte:number) => {
        //byte is 0-255
        const buf = Buffer.alloc(1)
        buf.writeUInt8(byte, 0)
        apb.append(buf)
    }

    module = structuredClone(module)
    const assets = module.assets ?? []
    module.assets = assets.map((asset) => {
        return [asset[0], '', asset[2]] as [string,string,string]
    })

    const mainbuf = await encodeRPack(Buffer.from(JSON.stringify({
        module: module,
        type: 'risuModule'
    }, null, 2), 'utf-8'))

    writeByte(111) //magic number
    writeByte(0) //version
    writeLength(mainbuf.length)
    apb.append(mainbuf)

    if(assets.length > 0){
        onProgress?.(0, assets.length)
    }
    for(let i=0;i<assets.length;i++){
        const asset = assets[i]
        writeByte(1) //mark as asset
        let rData = await readImage(asset[1])
        if(!rData){
            rData = new Uint8Array(0) //blank buffer
        }
        const encoded = await encodeRPack(Buffer.from(await compressImage(rData)))
        writeLength(encoded.length)
        apb.append(encoded)
        onProgress?.(i + 1, assets.length)
    }

    writeByte(0) //end of file

    return apb.buffer
}

export async function exportModuleLegacy(module:RisuModule){
    const fileName = `${module.name}.risum`
    const encoded = await encodeModuleLegacy(module, showExportAssetProgress)
    await exportPresetFile(fileName, encoded)
}

export async function readModule(buf:Buffer):Promise<RisuModule> {
    let pos = 0

    const readLength = () => {
        const len = buf.readUInt32LE(pos)
        pos += 4
        return len
    }
    const readByte = () => {
        const byte = buf.readUInt8(pos)
        pos += 1
        return byte
    }
    const readData = (len:number) => {
        const data = buf.subarray(pos, pos + len)
        pos += len
        return data
    }

    if(readByte() !== 111){
        console.error("Invalid magic number")
        alertError(language.errors.noData)
        return
    }
    if(readByte() !== 0){ //Version check
        console.error("Invalid version")
        alertError(language.errors.noData)
        return
    }

    const mainLen = readLength()
    const mainData = readData(mainLen)
    const main:{
        type:'risuModule'
        module:RisuModule
    } = JSON.parse(Buffer.from(await decodeRPack(mainData)).toString())

    if(main.type !== 'risuModule'){
        console.error("Invalid module type")
        alertError(language.errors.noData)
        return
    }

    let module = main.module

    const maxConcurrentAssetSaves = 10
    const retryDelayMs = 5000
    const maxRetries = 3
    const totalAssets = module.assets?.length ?? 0
    let completed = 0

    type AssetTask = {
        index: number
        data: Uint8Array
    }

    const runAssetTasks = async (tasks: AssetTask[]) => {
        if (tasks.length === 0) {
            return []
        }
        const inFlight = new Set<Promise<void>>()
        const failed: AssetTask[] = []
        const runTask = (task: AssetTask) => {
            const promise = (async () => {
                try {
                    const decoded = await decodeRPack(task.data)
                    if (!module.assets?.[task.index]) {
                        throw new Error(`Missing asset metadata for index ${task.index}`)
                    }
                    module.assets[task.index][1] = await saveAsset(decoded)
                    completed += 1
                } catch (error) {
                    failed.push(task)
                } finally {
                    alertWait(`Loading... (Adding Assets ${completed} / ${totalAssets})`)
                }
            })()
            inFlight.add(promise)
            promise.finally(() => inFlight.delete(promise))
        }

        for (const task of tasks) {
            while (inFlight.size >= maxConcurrentAssetSaves) {
                await Promise.race(inFlight)
            }
            runTask(task)
        }

        await Promise.all(inFlight)
        return failed
    }

    const tasks: AssetTask[] = []
    let i = 0
    while(true){
        const mark = readByte()
        if(mark === 0){
            break
        }
        if(mark !== 1){
            alertError(language.errors.noData)
            return
        }
        const len = readLength()
        const data = readData(len)
        tasks.push({
            index: i,
            data
        })
        i++
    }

    try {
        let failed = await runAssetTasks(tasks)
        let retryCount = 0
        while (failed.length > 0 && retryCount < maxRetries) {
            await sleep(retryDelayMs)
            retryCount += 1
            failed = await runAssetTasks(failed)
        }
        if (failed.length > 0) {
            throw new Error(`Failed to save ${failed.length} assets`)
        }
    } finally {
        alertClear()
    }

    module.id = createEntityId()
    return normalizePresetTagFields(module)
}

export function isModuleImportJSON(value:unknown):boolean{
    if(!value || typeof value !== 'object' || Array.isArray(value)){
        return false
    }
    const importData = value as Record<string, any>
    if(importData.type === 'risuModule'){
        return !!importData.name && !!importData.id
    }
    if(importData.type === 'risu' && importData.data && Array.isArray(importData.data)){
        return true
    }
    if(importData.entries){
        return true
    }
    return importData.type === 'regex' && !!importData.data
}

export async function importModule(input?:{name:string, data:Uint8Array}):Promise<boolean>{
    const f = input ?? await selectSingleImportFile()
    if(!f){
        return false
    }
    let fileData = f.data
    const fileName = f.name.toLowerCase()
    const db = getDatabase()
    if(fileName.endsWith('.charx')){
        try {
            const buf = Buffer.from(fileData)
            const char = await importCharacterProcess({
                name: f.name,
                data: buf,
                returnCharacter: true
            })
            if(!char || typeof char === 'number'){
                alertError(language.errors.noData)
                return false
            }
            const module = convertCharacterToModule(char)
            db.modules.push(normalizePresetTagFields(module))
            notifySuccess(language.successImport)
            return true
        } catch (error) {
            console.error(error)
            alertError(language.errors.noData)
            return false
        }
    }
    if(fileName.endsWith('.risum')){
        try {
            const buf = Buffer.from(fileData)
            const module = await readModule(buf)
            db.modules.push(normalizePresetTagFields(module))
            notifySuccess(language.successImport)
            return true
        } catch (error) {
            console.error(error)
            alertError(language.errors.noData)
            return false
        }
    }
    let importData:any
    try {
        importData = JSON.parse(Buffer.from(fileData).toString())
    } catch (error) {
        console.error(error)
        alertNormal(language.errors.noData)
        return false
    }
    if(!isModuleImportJSON(importData)){
        alertNormal(language.errors.noData)
        return false
    }

    try {
        if(importData.type === 'risuModule'){
            importData.id = createEntityId()

            if(importData.lowLevelAccess){
                const conf = await alertConfirm(language.lowLevelAccessConfirm)
                if(!conf){
                    return false
                }
            }
            db.modules.push(normalizePresetTagFields(importData))
            notifySuccess(language.successImport)
            return true
        }
        // importData.type === 'risu' in conflict with HypaV3 preset exports
        // difference: record vs. array
        if(importData.type === 'risu' && importData.data && Array.isArray(importData.data)){
            const lores:loreBook[] = importData.data
            const importModule = {
                name: importData.name || 'Imported Lorebook',
                description: importData.description || 'Converted from risu lorebook',
                lorebook: lores,
                id: createEntityId()
            }
            db.modules.push(importModule)
            notifySuccess(language.successImport)
            return true
        }
        if(importData.entries){
            const lores:loreBook[] = convertExternalLorebook(importData.entries)
            const importModule = {
                name: importData.name || 'Imported Lorebook',
                description: importData.description || 'Converted from external lorebook',
                lorebook: lores,
                id: createEntityId()
            }
            db.modules.push(importModule)
            notifySuccess(language.successImport)
            return true
        }
        if(importData.type === 'regex'  && importData.data){
            const regexs:customscript[] = importData.data
            const importModule = {
                name: importData.name || 'Imported Regex',
                description: importData.description || 'Converted from risu regex',
                regex: regexs,
                id: createEntityId()
            }
            db.modules.push(importModule)
            notifySuccess(language.successImport)
            return true
        }
    } catch (error) {
        console.error(error)
        alertNormal(language.errors.noData)
        return false
    }

    return false
}

function getModuleById(id:string){
    const db = getDatabase()
    for(let i=0;i<db.modules.length;i++){
        if(db.modules[i].id === id){
            return db.modules[i]
        }
    }

    if(id === '$embedded'){
        const persona = checkPersonaBinded()
        if(persona && persona.embeddedModule){
            return persona.embeddedModule
        }
    }
    return null
}

export function getModules(character = getCurrentCharacter(), chat = getCurrentChat()){
    return getEnabledModules(getDatabase(), character, chat)
}


export function getModuleLorebooks(character?: character, chat?: Chat) {
    const modules = getModules(character, chat)
    let lorebooks: loreBook[] = []
    for (const module of modules) {
        if(!module){
            continue
        }
        if (module.lorebook) {
            lorebooks = lorebooks.concat(module.lorebook)
        }
    }
    return lorebooks
}

export function getModuleAssets() {
    const modules = getModules()
    let assets: [string,string,string][] = []
    for (const module of modules) {
        if(!module){
            continue
        }
        if (module.assets) {
            assets = assets.concat(module.assets)
        }
    }
    return assets
}


export function getModuleTriggers(character?: character, chat?: Chat) {
    const modules = getModules(character, chat)
    let triggers: triggerscript[] = []
    for (const module of modules) {
        if(!module){
            continue
        }
        if (module.trigger) {
            // Runtime attribution must not leak into exported module data.
            triggers = triggers.concat(module.trigger.map((trigger) => ({
                ...trigger,
                lowLevelAccess: module.lowLevelAccess,
                moduleId: module.id,
            })))
        }
    }
    return triggers
}

export function getModuleRegexScripts(character?: character, chat?: Chat) {
    const modules = getModules(character, chat)
    let customscripts: customscript[] = []
    for (const module of modules) {
        if(!module){
            continue
        }
        if (module.regex) {
            customscripts = customscripts.concat(module.regex)
        }
    }
    return customscripts
}

export function getModuleMcps() {
    const modules = getModules()

    return modules.map((v) => v.mcp?.url).filter((v) => v)
}

export async function applyModule() {
    const sel = await alertModuleSelect()
    if (!sel) {
        return
    }

    const module = structuredClone(getModuleById(sel))
    if (!module) {
        return
    }

    const currentChar = getCurrentCharacter()
    if (!currentChar) {
        return
    }
    if (module.lorebook) {
        for (const lore of module.lorebook) {
            currentChar.globalLore.push(lore)
        }
    }
    if (module.regex) {
        for (const regex of module.regex) {
            currentChar.customscript.push(regex)
        }
    }
    if (module.trigger) {
        for (const trigger of module.trigger) {
            currentChar.triggerscript.push(trigger)
        }
    }

    setCurrentCharacter(currentChar)

    notifySuccess(language.successApplyModule)
}

export function moduleUpdate(){


    const m = getModules()

    let moduleHideIcon = false
    let backgroundEmbedding = ''
    m.forEach((module) => {
        if(!module){
            return
        }

        if(module.hideIcon){
            moduleHideIcon = true
        }
        if(module.backgroundEmbedding){
            backgroundEmbedding += '\n' + module.backgroundEmbedding + '\n'
        }
    })

    if(backgroundEmbedding){
        moduleBackgroundEmbedding.set(backgroundEmbedding)
    }
    HideIconStore.set(getCurrentCharacter()?.hideChatIcon || moduleHideIcon)

}
