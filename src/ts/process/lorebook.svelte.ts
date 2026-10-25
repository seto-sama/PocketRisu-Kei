import { getChatPage } from 'src/ts/storage/chatSelection.svelte'
import { Buffer } from 'buffer'
import { get } from "svelte/store";
import { getChatVarOf, setChatVarOf } from '../parser/chatVar.svelte';
import {selectedCharID} from '../stores.svelte'
import type { Chat, character, Message, loreBook } from "../storage/database.svelte";
import { DBState } from '../stores.svelte';
import { findCharacterbyId, pickHashRand, selectSingleImportFile } from "../util";
import { alertError, notifySuccess } from "../alert";
import { language } from "../../lang";
import { downloadFile, requestImmediateSave } from "../globalApi.svelte";
import { ensureChatHydrated, getChatServerEtag } from '../storage/chatStorage';
import { markChatWorkingCopyDirty } from '../storage/chatWorkingCopy';
import { getModuleLorebooks } from "./modules";
import { CCardLib } from "@risuai/ccardlib";
import { createEntityId } from 'src/ts/id';
import { selectLorebookPromptsWithinBudget } from "./lorebookPrompt";

type LorebookSearchText = {
    prompt: string
    data: string
    normalized?: {
        prompt: string
        data: string
        words?: Set<string>
        compact?: string
    }
}

export function addLorebook(type:number) {
    const selectedID = get(selectedCharID)
    if(type === 0){
        DBState.db.characters[selectedID].globalLore.push({
            key: '',
            comment: `New Lore ${DBState.db.characters[selectedID].globalLore.length + 1}`,
            content: '',
            mode: 'normal',
            insertorder: 100,
            alwaysActive: false,
            secondkey: "",
            selective: false
        })
    }
    else{
        const page = getChatPage(DBState.db.characters[selectedID])
        DBState.db.characters[selectedID].chats[page].localLore.push({
            key: '',
            comment: `New Lore ${DBState.db.characters[selectedID].chats[page].localLore.length + 1}`,
            content: '',
            mode: 'normal',
            insertorder: 100,
            alwaysActive: false,
            secondkey: "",
            selective: false
        })
    }
}

export function addLorebookFolder(type:number) {
    const selectedID = get(selectedCharID)
    const id = createEntityId()
    if(type === 0){
        DBState.db.characters[selectedID].globalLore.push({
            key: '\uf000folder:' + id,
            comment: `New Folder`,
            content: '',
            mode: 'folder',
            insertorder: 100,
            alwaysActive: false,
            secondkey: "",
            selective: false,
        })
    }
    else{
        const page = getChatPage(DBState.db.characters[selectedID])
        DBState.db.characters[selectedID].chats[page].localLore.push({
            key: '\uf000folder:' + id,
            comment: `New Folder`,
            content: '',
            mode: 'folder',
            insertorder: 100,
            alwaysActive: false,
            secondkey: "",
            selective: false,
        })
    }
}

export async function loadLoreBookV3Prompt(options: {
    includeModuleLorebooks?: boolean
    updateActivationState?: boolean
    character?: character
    chat?: Chat
} = {}){
    const char = options.character ?? DBState.db.characters[get(selectedCharID)]
    const chat = options.chat ?? char.chats[getChatPage(char)]
    const getVar = (key: string) => getChatVarOf(chat, key, char.defaultVariables)
    const characterLore = char.globalLore ?? []
    const chatLore = chat.localLore ?? []
    const moduleLorebook = options.includeModuleLorebooks === false ? [] : getModuleLorebooks(char, chat)
    const fullLore = characterLore.concat(chatLore, moduleLorebook).map(entry => ({ ...entry }))
    const currentChat = chat.message.filter(message => message.kind !== 'imageGeneration')
    const loreDepth = char.loreSettings?.scanDepth ?? DBState.db.loreBookDepth
    const loreToken = char.loreSettings?.tokenBudget ?? DBState.db.loreBookToken
    const fullWordMatchingSetting = char.loreSettings?.fullWordMatching ?? false
    const chatLength = currentChat.length + 1 //includes first message
    const recursiveScanning = char.loreSettings?.recursiveScanning ?? !DBState.db.disableGlobalLorebookRecursiveScanning
    const recursivePrompt:{
        source: string,
        text: LorebookSearchText
    }[] = []
    const messageTexts = new WeakMap<Message, LorebookSearchText>()
    const normalizeText = (text: string) => text.toLocaleLowerCase()
        .replace(/\{\{\/\/(.+?)\}\}/g, '').replace(/\{\{comment:(.+?)\}\}/g, '')
    const matchLog:{
        prompt: string,
        source: string
        activated: string
    }[] = []

    const searchMatch = (messages:Message[],arg:{
        keys:string[],
        searchDepth:number,
        regex:boolean
        fullWordMatching:boolean
        all?:boolean
        dontSearchWhenRecursive: boolean
    }) => {
        const sliced = messages.slice(messages.length - arg.searchDepth,messages.length)
        const keys: string[] = []
        for(const key of arg.keys){
            const trimmed = key.trim()
            if(trimmed.length > 0){
                keys.push(trimmed)
            }
        }
        const mList = sliced.map((msg, i) => {
            let text = messageTexts.get(msg)
            if(!text){
                const name = msg.role === 'user' ? DBState.db.username
                    : msg.name ?? (msg.saying ? findCharacterbyId(msg.saying)?.name : null) ?? char.name
                text = {
                    prompt: `\x01{{${name}}}:` + msg.data + '\x01',
                    data: msg.data,
                }
                messageTexts.set(msg, text)
            }
            return { source: `message ${i} by ${msg.role === 'user' ? 'user' : 'char'}`, text }
        })
        if(!arg.dontSearchWhenRecursive){
            for(const prompt of recursivePrompt) mList.push(prompt)
        }

        if(arg.regex){
            const regexes: { regex: RegExp, source: string }[] = []
            for(const source of keys){
                const parsed = source.match(/^\/([\s\S]*)\/([dgimsuvy]*)$/)
                if(!parsed){
                    return false
                }
                const [, pattern, flags] = parsed
                try {
                    regexes.push({ regex: new RegExp(pattern, flags), source })
                } catch {
                    return false
                }
            }
            for(const { text, source: messageSource } of mList){
                for(const { regex, source } of regexes){
                    if(regex.test(text.data)){
                        matchLog.push({
                            prompt: text.prompt,
                            source: messageSource,
                            activated: source
                        })
                        return true
                    }
                }
            }
            return false
        }

        const matchingKeys = keys.map(source => ({
            source,
            value: arg.fullWordMatching ? source.toLocaleLowerCase() : source.toLocaleLowerCase().replace(/ /g, ''),
        }))
        const allMode = arg.all ?? false
        let allModeMatched = true

        for(const { text, source } of mList){
            const normalized = text.normalized ??= {
                prompt: normalizeText(text.prompt),
                data: normalizeText(text.data),
            }
            const words = arg.fullWordMatching ? normalized.words ??= new Set(normalized.data.split(' ')) : null
            const compact = arg.fullWordMatching ? '' : normalized.compact ??= normalized.data.replace(/ /g, '')
            for(const key of matchingKeys){
                if(words ? words.has(key.value) : compact.includes(key.value)){
                    matchLog.push({ prompt: normalized.prompt, source, activated: key.source })
                    if(!allMode){
                        return true
                    }
                }
                else if(allMode){
                    allModeMatched = false
                }
            }
        }
        if(allMode && allModeMatched){
            return true
        }
        return false
    
    }

    let matching = true
    let actives:{
        depth:number,
        pos:string,
        prompt:string
        role:'system'|'user'|'assistant'
        hasRoleOverride:boolean
        order:number
        priority:number
        source:string
        inject:{
            operation:'append'|'prepend'|'replace',
            location:string,
            param:string
            lore:boolean
        }|null
    }[] = []
    const activatedIndexes = new Set<number>()
    while(matching){
        matching = false
        for(let i=0;i<fullLore.length;i++){
            if(activatedIndexes.has(i)){
                continue
            }
            if(!fullLore[i].alwaysActive && !fullLore[i].key){
                continue
            }
            let activated = true
            let pos = ''
            let inject:{
                operation:'append'|'prepend'|'replace',
                location:string,
                param:string
                lore:boolean
            } = null
            let depth = 0
            let scanDepth = loreDepth
            let order = fullLore[i].insertorder
            let priority = fullLore[i].insertorder
            let forceState:string = 'none'
            let role:'system'|'user'|'assistant' = 'system'
            let hasRoleOverride = false
            let searchQueries:{
                keys:string[],
                negative:boolean,
                all?:boolean
            }[] = []
            let fullWordMatching = fullWordMatchingSetting
            let dontSearchWhenRecursive = false
            let keepActivateAfterMatch = false
            let dontActivateAfterMatch = false
            
            if(fullLore[i].mode === 'child'){
                activated = false
                for(let j=0;j<i;j++){
                    if(fullLore[j].id === fullLore[i].id){
                        if(!activatedIndexes.has(j)){
                            fullLore[i].comment = fullLore[j].comment
                            fullLore[i].content = fullLore[j].content
                            fullLore[i].alwaysActive = true
                            activated = true
                        }
                        break
                    }
                }
            }
            let itemRecursive:'global'|true|false = 'global'
            const content = CCardLib.decorator.parse(fullLore[i].content, (name, arg) => {
                switch(name){
                    case 'end':{
                        pos = 'depth'
                        depth = 0
                        return
                    }
                    case 'activate_only_after':{
                        const int = parseInt(arg[0])
                        if(Number.isNaN(int)){
                            return false
                        }
                        if(chatLength < int){
                            activated = false
                        }
                        return
                    }
                    case 'activate_only_every': {
                        const int = parseInt(arg[0])
                        if(Number.isNaN(int)){
                            return false
                        }
                        if(chatLength % int !== 0){
                            activated = false
                        }
                        return
                    }
                    case 'keep_activate_after_match':{
                        const vara = getVar('__internal_ka_' + (fullLore[i].id ?? pickHashRand(5555,fullLore[i].content).toString()))
                        if(vara === 'true'){
                            forceState = 'activate'
                        }
                        else{
                            keepActivateAfterMatch = true
                        }
                        return false
                    }
                    case 'dont_activate_after_match': {
                        const vara = getVar('__internal_da_' + (fullLore[i].id ?? pickHashRand(5555,fullLore[i].content).toString()))
                        if(vara === 'true'){
                            forceState = 'deactivate'
                        }
                        else{
                            dontActivateAfterMatch = true
                        }
                        return false
                    }
                    case 'depth':
                    case 'reverse_depth':{
                        const int = parseInt(arg[0])
                        if(Number.isNaN(int)){
                            return false
                        }
                        depth = int
                        pos = name === 'depth' ? 'depth' : 'reverse_depth'
                        return
                    }
                    case 'instruct_depth':
                    case 'reverse_instruct_depth':
                    case 'instruct_scan_depth':{
                        // Risu has no instruct mode.
                        return false
                    }
                    case 'role':{
                        if(arg[0] === 'user' || arg[0] === 'assistant' || arg[0] === 'system'){
                            role = arg[0]
                            hasRoleOverride = true
                            return
                        }
                        return false
                    }
                    case 'scan_depth':{
                        scanDepth = parseInt(arg[0])
                        return
                    }
                    case 'is_greeting':{
                        const int = parseInt(arg[0])
                        if(Number.isNaN(int)){
                            return false
                        }
                        if(((chat.fmIndex ?? -1) + 1) !== int){
                            activated = false
                        }
                        return
                    }
                    case 'position':{
                        if(arg[0].startsWith('pt_') || ["after_desc", "before_desc", "personality", "scenario"].includes(arg[0])){
                            pos = arg[0]
                            return
                        }
                        return false
                    }
                    case 'inject_lore':{
                        inject ??= {
                            operation: 'append',
                            location: '',
                            param: '',
                            lore: true
                        }
                        inject.location = arg.join(' ')
                        inject.lore = true
                        return
                    }
                    case 'inject_at':{
                        inject??= {
                            operation: 'append',
                            location: '',
                            param: '',
                            lore: false
                        }
                        inject.location = arg.join(' ')
                        inject.lore = false
                        return
                    }
                    case 'inject_replace':{
                        inject??= {
                            operation: 'replace',
                            location: '',
                            param: '',
                            lore: false
                        }
                        inject.operation = 'replace'
                        inject.param = arg.join(' ')
                        return
                    }
                    case 'inject_prepend':{
                        inject??= {
                            operation: 'prepend',
                            location: '',
                            param: '',
                            lore: false
                        }
                        inject.operation = 'prepend'
                        inject.param = arg.join(' ')
                        return
                    }
                    case 'ignore_on_max_context':{
                        priority = -1000
                        return
                    }
                    case 'additional_keys':{
                        searchQueries.push({
                            keys: arg,
                            negative: false
                        })
                        return
                    }
                    case 'exclude_keys':{
                        searchQueries.push({
                            keys: arg,
                            negative: true
                        })
                        return
                    }
                    case 'exclude_keys_all':{
                        searchQueries.push({
                            keys: arg,
                            negative: true,
                            all: true
                        })
                        return
                    }
                    case 'match_full_word':{
                        fullWordMatching = true
                        return
                    }
                    case 'match_partial_word':{
                        fullWordMatching = false
                        return
                    }
                    case 'is_user_icon':{
                        // TODO: Implement the is_user_icon directive.
                        return false
                    }
                    case 'activate':{
                        forceState = 'activate'
                        return
                    }
                    case 'dont_activate':{
                        forceState = 'deactivate'
                        return
                    }
                    case 'disable_ui_prompt':{
                        if(['post_history_instructions','system_prompt'].includes(arg[0])){
                            return
                        }
                        return false
                    }
                    case 'probability':{
                        if(Math.random() * 100 > parseInt(arg[0])){
                            activated = false
                        }
                        return
                    }
                    case 'priority':{
                        priority = parseInt(arg[0])
                        return
                    }
                    case 'unrecursive':{
                        itemRecursive = false
                        return
                    }
                    case 'recursive':{
                        itemRecursive = true
                        return
                    }
                    case 'no_recursive_search':{
                        dontSearchWhenRecursive = true
                        return
                    }
                    default:{
                        return false
                    }
                }
            })
            

            if(activated && forceState === 'none' && !fullLore[i].alwaysActive){
                searchQueries.push({
                    keys: fullLore[i].key.split(','),
                    negative: false
                })

                if(fullLore[i].secondkey && fullLore[i].selective){
                    searchQueries.push({
                        keys: fullLore[i].secondkey.split(','),
                        negative: false
                    })
                }
    
                for(const query of searchQueries){
                    const result = searchMatch(currentChat, {
                        keys: query.keys,
                        searchDepth: scanDepth,
                        regex: fullLore[i].useRegex,
                        fullWordMatching: fullWordMatching,
                        all: query.all,
                        dontSearchWhenRecursive: dontSearchWhenRecursive
                    })
                    if(query.negative){
                        if(result){
                            activated = false
                            break
                        }
                    }
                    else{
                        if(!result){
                            activated = false
                            break
                        }
                    }
                }
            }

            if(forceState === 'activate'){
                activated = true
            }
            else if(forceState === 'deactivate'){
                activated = false
            }

            if(activated){
                actives.push({
                    depth: depth,
                    pos: pos,
                    prompt: content,
                    role: role,
                    hasRoleOverride: hasRoleOverride,
                    order: order,
                    priority: priority,
                    source: fullLore[i].comment || `lorebook ${i}`,
                    inject: inject ?? null
                })
                activatedIndexes.add(i)

                if(keepActivateAfterMatch && options.updateActivationState !== false){
                    setChatVarOf(chat, '__internal_ka_' + (fullLore[i].id ?? pickHashRand(5555,fullLore[i].content).toString()), 'true')
                }
                if(dontActivateAfterMatch && options.updateActivationState !== false){
                    setChatVarOf(chat, '__internal_da_' + (fullLore[i].id ?? pickHashRand(5555,fullLore[i].content).toString()), 'true')
                }


                let recursive = recursiveScanning
                if(itemRecursive !== 'global'){
                    recursive = itemRecursive
                }

                if(recursive){
                    matching = true
                    recursivePrompt.push({
                        text: { prompt: content, data: content },
                        source: 'lorebook ' + (fullLore[i].comment || `lorebook ${i}`),
                    })
                }
            }
        }
    }

    let activesResorted = await selectLorebookPromptsWithinBudget(actives, loreToken, char)


    const loreinjectionLores = activesResorted.filter((act) => {
        return act?.inject?.lore
    })

    activesResorted = activesResorted.filter((act) => {
        return !act?.inject?.lore
    })

    // Apply lore injection after budgeting to avoid another token-count pass.

    if (import.meta.env.DEV) {
        console.log('loreinjectionLores', loreinjectionLores)
    }
    for(const lore of loreinjectionLores){
        const foundLoreIndex = activesResorted.findIndex((l) => {
            return l.source === lore.inject.location
        })
        if(foundLoreIndex !== -1){
            const foundLore = activesResorted[foundLoreIndex]
            switch(lore.inject.operation){
                case 'append':{
                    foundLore.prompt += ' ' + lore.prompt
                    break
                }
                case 'prepend':{
                    foundLore.prompt = lore.prompt + ' ' + foundLore.prompt
                    break
                }
                case 'replace':{
                    foundLore.prompt = foundLore.prompt.replace(lore.inject.param, lore.prompt)
                    break
                }
            }
        }
    }

    return {
        actives: activesResorted.reverse(),
        matchLog: matchLog,
    }

}

export async function importLoreBook(mode:'global'|'local'){
    const initialCharacter = DBState.db.characters[get(selectedCharID)]
    if (!initialCharacter || initialCharacter.trashTime) return
    const characterId = initialCharacter.chaId
    const chatId = mode === 'local' ? initialCharacter.chats[getChatPage(initialCharacter)]?.id : undefined
    if (mode === 'local' && !chatId) return
    const getTargetCharacter = () => DBState.db.characters.find(character =>
        character.chaId === characterId && !character.trashTime)
    const lorebook = (await selectSingleImportFile())?.data
    if(!lorebook){
        return
    }
    try {
        const importedlore = JSON.parse(Buffer.from(lorebook).toString('utf-8'))
        const entries: loreBook[] = importedlore.type === 'risu' && Array.isArray(importedlore.data)
            ? importedlore.data
            : importedlore.entries ? convertExternalLorebook(importedlore.entries) : []
        if (entries.length === 0) return
        const character = getTargetCharacter()
        if (!character) return
        if(mode === 'global'){
            for (const entry of entries) character.globalLore.push(entry)
            await requestImmediateSave({ characterIds: [characterId] })
        }
        else{
            const index = character.chats.findIndex(chat => chat.id === chatId)
            if (index === -1) return
            let chat = character.chats[index]
            if (chat._placeholder) {
                await ensureChatHydrated(character, index)
                // Re-resolve only after hydration yields; sync may replace the body.
                chat = getTargetCharacter()?.chats.find(chat => chat.id === chatId)
                if (!chat || chat._placeholder) return
            }
            const lore = chat.localLore ??= []
            for (const entry of entries) lore.push(entry)
            markChatWorkingCopyDirty(characterId, chatId, getChatServerEtag(characterId, chatId))
            await requestImmediateSave({ chatTargets: [{ characterId, chatId }] })
        }
    } catch (error) {
        alertError(error)
    }
}

export interface CCLorebook{
    key:string[]
    comment:string
    content:string
    order:number
    constant:boolean,
    name:string,
    keywords:string[],
    priority:number
    entry:string
    secondary_keys:string[]
    selective:boolean
    forceActivation:boolean
    keys:string[]
    displayName:string
    text:string
    contextConfig?: {
        budgetPriority:number
        prefix:string
        suffix:string
    }
}

export function convertExternalLorebook(entries:{[key:string]:CCLorebook}){
    let lore:loreBook[] = []
    for(const key in entries){
        const currentLore = entries[key]
        lore.push({
            key: currentLore.key ? currentLore.key.join(', ') :
                currentLore.keys ? currentLore.keys.join(', ') :
                currentLore.keywords ? currentLore.keywords.join(', ') : '',
            insertorder: currentLore.order ?? currentLore.priority ?? currentLore?.contextConfig?.budgetPriority ?? 0,
            comment: currentLore.comment || currentLore.name || currentLore.displayName || '',
            content: currentLore.content || currentLore.entry || currentLore.text || '',
            mode: "normal",
            alwaysActive: currentLore.constant ?? currentLore.forceActivation ?? false,
            secondkey: currentLore.secondary_keys ? currentLore.secondary_keys.join(', ') : "",
            selective: currentLore.selective ?? false
        })
    }
    return lore
}

export async function exportLoreBook(mode:'global'|'local'){
    try {
        const selectedID = get(selectedCharID)
        const page = getChatPage(DBState.db.characters[selectedID])
        const lore = 
            mode === 'global' ? DBState.db.characters[selectedID].globalLore : 
            DBState.db.characters[selectedID].chats[page].localLore        
        const stringl = Buffer.from(JSON.stringify({
            type: 'risu',
            ver: 1,
            data: lore
        }), 'utf-8')

        await downloadFile(`lorebook_export.json`, stringl)

        notifySuccess(language.browserDownloadStarted)
    } catch (error) {
        alertError(error)
    }
}
