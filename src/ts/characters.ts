import { isDebugEnabled } from 'src/ts/debug'
import { getChatPage, setChatPage, initializeChatSelection } from './storage/chatSelection.svelte'
import { Buffer } from 'buffer'
import { get } from "svelte/store";
import { saveImage, setDatabase, type character, type Chat, type loreBook, getDatabase, getCharacterByIndex, setCharacterByIndex, getCurrentChat, loadTogglesFromChat, normalizeChat, newChatModelDefaults } from "./storage/database.svelte";
import { ensureChatHydrated } from "./storage/chatStorage";
import { alertAddCharacter, alertConfirm, alertError, alertSelect, alertStore, alertWait, notifySuccess, notifyInfo } from "./alert";
import { dismissClaimedLoadingOverlay, chatDeselected } from "./stores.svelte";
import { language } from "../lang";
import { checkNullish, findCharacterbyId, getUserName, selectFileByDom, selectSingleImageFile, selectSingleImportFile } from "./util";
import { createEntityId } from 'src/ts/id';
import { getImageType } from "./media";
import { OpenRealmStore, selectedCharID } from "./stores.svelte";
import { AppendableBuffer, changeChatTo, checkCharOrder, hydrateSelectedChat, downloadFile, getFileSrc, requestImmediateSave, requiresFullEncoderReload } from "./globalApi.svelte";
import { parseMarkdownSafe } from "./parser/parser.svelte";
import { translateHTML } from "./translator/translator";
import { importCharacterProcess } from "./characterCards";
import { importCharacterPackage } from "./characterPackage";
import { PngChunk } from "./pngChunk";
import { PRODUCT_NAME } from "./branding";
import {
    remapBookmarkTags,
} from './bookmarks/bookmarkData'
import {
    finalizeImportedBookmarks,
    mergeBookmarkTagsForImport,
    prepareBookmarkCompatibleChats,
} from './bookmarks/bookmarkService'
import { archiveCurrentCharacterIcon, emotionImageToAsset } from './characterAssets'
import { moveToTrash, restoreFromTrash } from './characterTrash'
import { importRisuChats } from './chatImport'

const BOOKMARK_TAG_DATA_CLASS = 'bookmark-tag-data'

async function importCharactersAndPackages() {
    const files = await selectFileByDom(['*'], 'multiple')
    if (!files.length) return
    const existingCharacterIds = new Set(getDatabase().characters.map(character => character.chaId))

    for (const file of files) {
        if (file.name.toLowerCase().endsWith('.zip')) {
            await importCharacterPackage({
                name: file.name,
                data: new Uint8Array(await file.arrayBuffer()),
            })
        } else {
            await importCharacterProcess({ name: file.name, data: file })
            checkCharOrder()
        }
    }
    return getDatabase().characters.findLast(character =>
        !character.trashTime && !existingCharacterIds.has(character.chaId))?.chaId
}

export async function getCharImage(loc:string, type:'plain'|'css'|'contain'|'lgcss') {
    const db = getDatabase()
    
    if(db.hideAllImages){
        return ''  // Callers show the same fallback as a character without an image
    }
    
    if(!loc || loc === ''){
        if(type ==='css'){
            return ''
        }
        return null
    }
    const filesrc = await getFileSrc(loc)
    if(type === 'plain'){
        return filesrc
    }
    const coverBackground = `background: url("${filesrc}");background-size: cover;background-repeat: no-repeat;`
    if(type ==='css'){
        return coverBackground
    }
    else if(type === 'lgcss'){
        return `${coverBackground}height: 10.66rem;`

    }

    else{
        return `background: url("${filesrc}");background-size: contain;background-repeat: no-repeat;background-position: center;`
    }
}

export async function selectCharImg(charIndex:number) {
    const selected = await selectSingleImageFile()
    if(!selected){
        return
    }
    const img = selected.data
    let db = getDatabase()

    const type = getImageType(img)

    try {
        if(type === 'PNG'){
            const gen = PngChunk.readGenerator(img)
            const allowedChunk = [
                'parameters', 'Comment', 'Title', 'Description', 'Author', 'Software', 'Source', 'Disclaimer', 'Warning', 'Copyright',
            ]
            for await (const chunk of gen){
                if(chunk instanceof AppendableBuffer){
                    continue
                }
                if(!chunk){
                    continue
                }
                if(chunk.value.length > 20_000){
                    continue
                }
                if(allowedChunk.includes(chunk.key)){
                    if (isDebugEnabled()) {
                        console.debug(chunk.key, chunk.value)
                    }
                    db.characters[charIndex].extentions ??= {}
                    db.characters[charIndex].extentions.pngExif ??= {}
                    db.characters[charIndex].extentions.pngExif[chunk.key] = chunk.value
                }
            }
            if (isDebugEnabled()) {
                console.debug(db.characters[charIndex].extentions)
            }
        }   
    } catch (error) {
        console.error(error)
    }



    const imgp = await saveImage(img)
    dumpCharImage(charIndex)
    db.characters[charIndex].image = imgp
}

export function dumpCharImage(charIndex:number) {
    let db = getDatabase()
    const char = db.characters[charIndex] as character
    archiveCurrentCharacterIcon(char)
    db.characters[charIndex] = char
}

export function changeCharImage(charIndex:number,changeIndex:number) {
    let db = getDatabase()
    const char = db.characters[charIndex] as character
    const image = char.ccAssets[changeIndex].uri
    char.ccAssets.splice(changeIndex, 1)
    dumpCharImage(charIndex)
    char.image = image
    db.characters[charIndex] = char
}


function getCurrentExportTheme() {
    const styles = getComputedStyle(document.documentElement)
    const read = (token:string) => styles.getPropertyValue(token).trim()

    return {
        background: read('--risu-theme-lightbg'),
        surface: read('--risu-theme-darkbg'),
        text: read('--risu-theme-maintext'),
        mutedText: read('--risu-theme-subtext'),
        border: read('--risu-theme-darkborderc'),
        accentBorder: read('--risu-theme-lightborderc'),
        primary: read('--risu-theme-primary'),
    }
}


export async function exportChat(page:number){
    try {

        const mode = await alertSelect(['Export as JSON', "Export as TXT", "Export as HTML File", "Export as HTML Embed"])
        if(mode === '-1') return

        let doTranslate = false
        let anonymous = false
        if(mode === '2' || mode === '3'){
            const translationMode = await alertSelect([language.translateContent, language.doNotTranslate])
            if(translationMode === '-1') return
            doTranslate = translationMode === '0'

            const personaNameMode = await alertSelect([language.includePersonaName, language.hidePersonaName])
            if(personaNameMode === '-1') return
            anonymous = personaNameMode === '1'
        }
        const selectedID = get(selectedCharID)
        const db = getDatabase()
        const char = db.characters[selectedID]
        // Export needs the full chat body, not a server placeholder.
        if(char.chats[page]?._placeholder){
            await ensureChatHydrated(char, page)
        }
        if(char.chats[page]?._placeholder){
            alertError('Failed to load chat data. Export aborted.')
            return
        }
        const chat = char.chats[page]
        const date = new Date().toJSON();
        const bookmarkExport = mode === '0' || mode === '2'
            ? await prepareBookmarkCompatibleChats(char.chaId, [chat])
            : { chats: [chat], tags: [] }
        const compatibleChat = bookmarkExport.chats[0]
        const htmlChatParse = async (v:string) => {
            v = parseMarkdownSafe(v)

            if(doTranslate){
                v = await translateHTML(v, false, '', -1)
            }

            if(anonymous){
                const excapedName = char.name.replace(/[-\/\\^$*+\?\.()|[\]{}]/g, '\\$&')

                v = v.replace(new RegExp(`${excapedName}`, 'gi'), '×××')
            }

            return v
        }

        if(mode === '0'){
            let folders = []
            if(chat.folderId) {
                folders = db.characters[selectedID].chatFolders?.filter(f => f.id === chat.folderId)
            }
            const stringl = Buffer.from(JSON.stringify({
                type: 'risuChat',
                ver: 2,
                data: compatibleChat,
                folders: folders,
                bookmarkTags: bookmarkExport.tags,
            }), 'utf-8')
    
            await downloadFile(`${char.name}_${date}_chat`.replace(/[<>:"/\\|?*\.\,]/g, "") + '.json', stringl)
    
        }
        else if(mode === '2'){
            const theme = getCurrentExportTheme()

            let chatContentHTML = ''

            let i = 0
            for(const v of chat.message){
                alertWait(`Translating... ${i++}/${chat.message.length}`)
                const name = v.saying ? findCharacterbyId(v.saying).name : v.role === 'char' ? char.name : anonymous ? '×××' : getUserName()
                chatContentHTML += `<div class="chat">
                    <h2>${name}</h2>
                    <div>${await htmlChatParse(v.data)}</div>
                </div>`
            }

            const doc = `
                <!DOCTYPE html>
                <html>
                    <head>
                        <title>${char.name} Chat</title>
                        <style>
                            body{
                                font-family: Arial, sans-serif;
                                display: flex;
                                justify-content: center;
                                min-height: 100vh;
                                min-height: 100dvh;
                                margin: 0;
                                background: ${theme.background};
                                color: ${theme.text};
                            }
                            .container{
                                width: 100%;
                                max-width: 800px;
                                padding: 1rem;
                                border-radius: 10px;
                                display: flex;
                                flex-direction: column;
                                gap: 1rem;
                            }
                            .chat{
                                background: ${theme.surface};
                                color: ${theme.text};
                                border: 1px solid ${theme.border};
                                padding: 1rem;
                                border-radius: 10px;
                                display: flex;
                                flex-direction: column;
                            }
                            .idat{
                                display: none;
                            }
                            h2{
                                margin: 0;
                                color: ${theme.text};
                            }
                            .chat > div{
                                margin-top: 0.5rem;
                                overflow-wrap: anywhere;
                            }
                            a{
                                color: ${theme.primary};
                            }
                            blockquote{
                                margin-left: 0;
                                padding-left: 1rem;
                                border-left: 3px solid ${theme.accentBorder};
                                color: ${theme.mutedText};
                            }
                            code, pre{
                                background: ${theme.background};
                                color: ${theme.text};
                            }
                            pre{
                                padding: 0.75rem;
                                overflow-x: auto;
                            }
                            table{
                                border-collapse: collapse;
                            }
                            th, td{
                                border: 1px solid ${theme.border};
                                padding: 0.5rem;
                            }
                            img{
                                max-width: 100%;
                                height: auto;
                            }
                        </style>
                    </head>
                    <body>
                        <div class="container">
                            <div class="chat">
                                <h2>${char.name}</h2>
                                <div>${await htmlChatParse(
                                    chat.fmIndex === -1 ? char.firstMessage : char.alternateGreetings?.[chat.fmIndex ?? 0]
                                )}</div>
                            </div>
                            ${chatContentHTML}
                        </div>
                        <div class="idat">${
                            JSON.stringify(compatibleChat).replace(/</g, '&lt;').replace(/>/g, '&gt;')
                        }</div>
                        <div class="idat ${BOOKMARK_TAG_DATA_CLASS}">${
                            JSON.stringify(bookmarkExport.tags)
                                .replace(/</g, '&lt;').replace(/>/g, '&gt;')
                        }</div>
                    </body>
                </html>
            `


            await downloadFile(`${char.name}_${date}_chat`.replace(/[<>:"/\\|?*\.\,]/g, "") + '.html', Buffer.from(doc, 'utf-8'))
        }
        else if(mode === '3'){
            const theme = getCurrentExportTheme()
            const cellStyle = `padding: 0.75rem; border: 1px solid ${theme.border}; vertical-align: top; text-align: left;`
            let chatContentHTML = ''

            let i = 0
            for(const v of chat.message){
                alertWait(`Translating... ${i++}/${chat.message.length}`)
                const name = v.saying ? findCharacterbyId(v.saying).name : v.role === 'char' ? char.name : anonymous ? '×××' : getUserName()
                chatContentHTML += `<tr>
                    <td style="${cellStyle}">${name}</td>
                    <td style="${cellStyle}">${await htmlChatParse(v.data)}</td>
                </tr>`
            }

            const template = `
                <div style="font-family: Arial, sans-serif; max-width: 800px; padding: 1rem; background: ${theme.background}; color: ${theme.text};">
                <table style="width: 100%; border-collapse: collapse; background: ${theme.surface}; color: ${theme.text}; border: 1px solid ${theme.border};">
                    <tr>
                        <th style="${cellStyle} background: ${theme.background}; color: ${theme.text};">Character</th>
                        <th style="${cellStyle} background: ${theme.background}; color: ${theme.text};">Message</th>
                    </tr>
                    <tr>
                        <td style="${cellStyle}">${char.name}</td>
                        <td style="${cellStyle}">${await htmlChatParse(char.firstMessage)}</td>
                    </tr>
                    ${chatContentHTML}
                </table>
                <p style="color: ${theme.mutedText};">Chat from ${PRODUCT_NAME}</p>
                </div>
            `

            const item = new ClipboardItem({
                'text/html': new Blob([template], { type: 'text/html' }),
                'text/plain': new Blob([template], { type: 'text/plain' })
            })
            await navigator.clipboard.write([item])

            notifyInfo(language.clipboardSuccess)
            return

        }
        else{
            
            let stringl = chat.message.map((v) => {
                if(v.saying){
                    return `--${findCharacterbyId(v.saying).name}\n${v.data}`
                }
                else{
                    return `--${v.role === 'char' ? char.name : getUserName()}\n${v.data}`
                }
            }).join('\n\n')

            stringl = `--${char.name}\n${char.firstMessage}\n\n` + stringl

            await downloadFile(`${char.name}_${date}_chat`.replace(/[<>:"/\\|?*\.\,]/g, "") + '.txt', Buffer.from(stringl, 'utf-8'))

        }
        notifySuccess(language.browserDownloadStarted)
    } catch (error) {
        alertError(error)
    }
}

export async function importChat(){
    const dat = await selectSingleImportFile()
    if(!dat){
        return
    }
    try {
        const selectedID = get(selectedCharID)
        let db = getDatabase()

        if(dat.name.endsWith('jsonl')){
            const lines = Buffer.from(dat.data).toString('utf-8').split('\n')
            let newChat:Chat = {
                message: [],
                note: "",
                name: "Imported Chat",
                localLore: [],
                fmIndex: -1,
                id: createEntityId(),
                ...newChatModelDefaults()
            }

            let isFirst = true
            for(const line of lines){
                
                const presedLine = JSON.parse(line)
                if(presedLine.name && presedLine.is_user, presedLine.mes){
                    if(!isFirst){
                        newChat.message.push({
                            role: presedLine.is_user ? "user" : 'char',
                            data: formatTavernChat(presedLine.mes, db.characters[selectedID].name)
                        })
                    }
                }

                isFirst = false
            }

            if(newChat.message.length === 0){
                alertError(language.errors.noData)
                return
            }

            if(db.characters[selectedID].chatFolders
                .filter(folder => folder.id === newChat.folderId).length === 0) {
                newChat.folderId = null
            }

            db.characters[selectedID].chats.unshift(newChat)
            changeChatTo(0)
            notifySuccess(language.successImport)
        }
        else if(dat.name.endsWith('json')){
            const json = JSON.parse(Buffer.from(dat.data).toString('utf-8'))
            if (await importRisuChats(json, db.characters[selectedID])) notifySuccess(language.successImport)
            else alertError(language.errors.noData)
            return
        }
        else if(dat.name.endsWith('html')){
            const doc = new DOMParser().parseFromString(Buffer.from(dat.data).toString('utf-8'), 'text/html')
            const chat = doc.querySelector('.idat').textContent
            const json = JSON.parse(chat)
            const bookmarkTagData = doc.querySelector(`.${BOOKMARK_TAG_DATA_CLASS}`)?.textContent
            const bookmarkTagIdMap = await mergeBookmarkTagsForImport(
                bookmarkTagData ? JSON.parse(bookmarkTagData) : undefined,
            )
            if(!(checkNullish(json.message) || checkNullish(json.note) || checkNullish(json.name) || checkNullish(json.localLore))){
                remapBookmarkTags(json, bookmarkTagIdMap)
                json.id = createEntityId()
                const importedChat = normalizeChat(json)
                db.characters[selectedID].chats.unshift(importedChat)
                await requestImmediateSave({
                    characterIds: [db.characters[selectedID].chaId],
                    chatTargets: [{
                        characterId: db.characters[selectedID].chaId,
                        chatId: importedChat.id,
                    }],
                })
                await finalizeImportedBookmarks([importedChat])
                notifySuccess(language.successImport)
            }
            else{
                alertError(language.errors.noData)
            }
        }
    } catch (error) {
        alertError(error)
    }
}

export async function exportAllChats() {
    try {
        const selectedID = get(selectedCharID)
        const db = getDatabase()
        const char = db.characters[selectedID]
        const date = new Date().toISOString().replace(/[:.]/g, "-")

        for (let i = 0; i < char.chats.length; i++) {
            if (char.chats[i]?._placeholder) {
                alertWait(`Loading chat data... (${i + 1}/${char.chats.length})`)
                await ensureChatHydrated(char, i)
            }
            if (char.chats[i]?._placeholder) {
                alertError(`Failed to load chat data for "${char.chats[i].name}". Export aborted to prevent data loss.`)
                return
            }
        }

        const bookmarkExport = await prepareBookmarkCompatibleChats(char.chaId, char.chats)
        const allFolders = char.chatFolders
        const stringl = Buffer.from(JSON.stringify({
            type: 'risuAllChats',
            ver: 2,
            data: bookmarkExport.chats,
            folders: allFolders,
            bookmarkTags: bookmarkExport.tags,
        }), 'utf-8')
        await downloadFile(`${char.name}_all_chats_${date}`.replace(/[<>:"/\\|?*.,]/g, "") + '.json', stringl)
        notifySuccess(language.browserDownloadStarted)
    } catch (error) {
        alertError(error)
    }
}

function formatTavernChat(chat:string, charName:string){
    return chat.replace(/<([Uu]ser)>|\{\{([Uu]ser)\}\}/g, getUserName()).replace(/((\{\{)|<)([Cc]har)(=.+)?((\}\})|>)/g, charName)
}

export function characterFormatUpdate(indexOrCharacter:number|character){
    let cha = typeof(indexOrCharacter) === 'number' ? getCharacterByIndex(indexOrCharacter) : indexOrCharacter
    if (!cha.chaId) cha.chaId = createEntityId()
    initializeChatSelection(cha)
    if(cha.chats.length === 0){
        cha.chats = [{
            message: [],
            note: '',
            name: 'Chat 1',
            localLore: [],
            ...newChatModelDefaults()
        }]
    }
    if(!cha.chats[getChatPage(cha)]){
        setChatPage(cha, 0)
    }
    if(!cha.chats[getChatPage(cha)].message){
        cha.chats[getChatPage(cha)].message = []
    }
    if(!cha.type){
        cha.type = 'character'
    }
    if(checkNullish(cha.utilityBot)){
        cha.utilityBot = false
    }
    cha.triggerscript = cha.triggerscript ?? []
    cha.alternateGreetings = cha.alternateGreetings ?? []
    cha.exampleMessage = cha.exampleMessage ?? ''
    cha.creatorNotes = cha.creatorNotes ?? ''
    cha.systemPrompt = cha.systemPrompt ?? ''
    cha.tags = cha.tags ?? []
    cha.creator = cha.creator ?? ''
    cha.characterVersion = cha.characterVersion ?? ''
    cha.personality = cha.personality ?? ''
    cha.scenario = cha.scenario ?? ''
    cha.firstMsgIndex = cha.firstMsgIndex ?? -1
    cha.additionalData = cha.additionalData ?? {
        tag: [],
        creator: '',
        character_version: ''
    }
    if(cha.postHistoryInstructions){
        cha.chats[getChatPage(cha)].note += "\n" + cha.postHistoryInstructions
        cha.chats[getChatPage(cha)].note = cha.chats[getChatPage(cha)].note.trim()
        cha.postHistoryInstructions = null
    }
    cha.additionalText ??= ''
    cha.depth_prompt ??= {
        depth: 0,
        prompt: ''
    }
    cha.backgroundHTML ??= ''
    cha.backgroundCSS ??= ''
    cha.creation_date ??= Date.now()
    cha.globalLore = updateLorebooks(cha.globalLore)
    migrateEmotionImagesToAssets(cha)
    if(checkNullish(cha.customscript)){
        cha.customscript = []
    }
    if(typeof(indexOrCharacter) === 'number'){
        setCharacterByIndex(indexOrCharacter, cha)
    }
    for(let i = 0; i < cha.chats.length; i++){
        const chat = cha.chats[i]
        chat.fmIndex ??= cha.firstMsgIndex ?? -1
        if(!chat.id){
            chat.id = createEntityId()
        }
        if(!chat.localLore){
            chat.localLore = []
        }
    }
    return cha
}

type LegacyEmotionCharacter = character & {
    viewScreen?: string
    inlayViewScreen?: boolean
    newGenData?: unknown
}

/** Moves legacy emotion images into additional assets so the asset prompt can show them. */
export function migrateEmotionImagesToAssets(cha:character): void {
    const legacy = cha as LegacyEmotionCharacter
    const emotions = (cha.emotionImages ?? []).filter((emotion) => emotion?.[0] && emotion?.[1])
    if(emotions.length > 0){
        cha.additionalAssets ??= []
        for(const [name, path] of emotions){
            // Same-name images stay as separate entries so the parser picks between them randomly.
            if(cha.additionalAssets.some(([assetName, assetPath]) => assetName === name && assetPath === path)) continue
            cha.additionalAssets.push(emotionImageToAsset([name, path]))
        }
        cha.prebuiltAssetCommand = true
        getDatabase().newImageHandlingBeta = true
    }
    if(legacy.emotionImages !== undefined) delete legacy.emotionImages
    if(legacy.viewScreen !== undefined) delete legacy.viewScreen
    if(legacy.inlayViewScreen !== undefined) delete legacy.inlayViewScreen
    if(legacy.newGenData !== undefined) delete legacy.newGenData
}

export function updateLorebooks(book:loreBook[]){
    return book.map((v) => {
        v.bookVersion ??= 1
        if(v.bookVersion >= 2){
            return v
        }
        if(v.activationPercent){
            const perc = v.activationPercent
            v.activationPercent = null

            v.content = `@@probability ${perc}\n${v.content}`
        }
        v.content = v.content.replace(/@@@?end/g, '@@depth 0').replace(/\<(char|bot)\>/g, '{{char}}').replace(/\<(user)\>/g, '{{user}}')
        v.bookVersion = 2
        return v
    })

}

// SYNC: server/server.cjs promoteFailedColdStorageStub() mirrors these defaults.
export function createBlankChar():character{
    return {
        name: '',
        firstMessage: '',
        desc: '',
        notes: '',
        chats: [{
            message: [],
            note: '',
            name: 'Chat 1',
            localLore: [],
            ...newChatModelDefaults()
        }],
        chatFolders: [],
        bias: [],
        globalLore: [],
        chaId: createEntityId(),
        type: 'character',
        utilityBot: false,
        lowLevelAccess: false,
        hideChatIcon: false,
        escapeOutput: false,
        customscript: [],
        exampleMessage: '',
        creatorNotes:'',
        systemPrompt:'',
        postHistoryInstructions:'',
        alternateGreetings:[],
        tags:[],
        creator:"",
        characterVersion: '',
        personality:"",
        scenario:"",
        firstMsgIndex: -1,
        replaceGlobalNote: "",
        triggerscript: [{
            comment: "",
            type: "manual",
            conditions: [],
            effect: [{
                type: "v2Header",
                code: "",
                indent: 0
            }]
        }, {
            comment: "New Event",
            type: 'manual',
            conditions: [],
            effect: []
        }],
        additionalText: ''
    }
}


const charactersBeingRemoved = new WeakSet<object>()
let activeCharacterRemovalCount = 0
let emptyingCharacterTrash = false

export async function removeChar(index:number,name:string, type:'normal'|'permanent'|'permanentForce' = 'normal'){
    const db = getDatabase()
    const targetCharacter = db.characters[index]
    if(!targetCharacter || emptyingCharacterTrash || charactersBeingRemoved.has(targetCharacter)){
        return
    }

    charactersBeingRemoved.add(targetCharacter)
    activeCharacterRemovalCount++
    try{
        if(type !== 'permanentForce'){
            const conf = await alertConfirm(language.removeConfirm + name)
            if(!conf){
                return
            }
            if(type === 'permanent'){
                const conf2 = await alertConfirm(language.removeConfirm2 + name)
                if(!conf2){
                    return
                }
            }
        }
        let currentIndex = db.characters.findIndex((character) => character === targetCharacter)
        if(currentIndex === -1 && targetCharacter.chaId){
            currentIndex = db.characters.findIndex((character) => character.chaId === targetCharacter.chaId)
        }
        if(currentIndex === -1){
            return
        }

        let chars = db.characters
        if(type === 'normal'){
            moveToTrash(db.characterOrder, chars[currentIndex])
        }
        else{
            chars.splice(currentIndex, 1)
        }
        checkCharOrder()
        db.characters = chars
        requiresFullEncoderReload.state = true
        selectedCharID.set(-1)
        await requestImmediateSave({ characterIds: [targetCharacter.chaId] })
    }
    finally{
        charactersBeingRemoved.delete(targetCharacter)
        activeCharacterRemovalCount--
    }
}

export function restoreCharacterFromTrash(character: character){
    restoreFromTrash(getDatabase().characterOrder, character)
    checkCharOrder()
}

export async function emptyCharacterTrash(){
    if(emptyingCharacterTrash || activeCharacterRemovalCount > 0){
        return false
    }

    emptyingCharacterTrash = true
    try{
        const db = getDatabase()
        const trashedCharacterIds = db.characters
            .filter((character) => !!character.trashTime)
            .map((character) => character.chaId)
        const trashedCount = trashedCharacterIds.length
        if(trashedCount === 0){
            return false
        }

        const confirmed = await alertConfirm(
            language.emptyTrashConfirm.replace('{count}', trashedCount.toString())
        )
        if(!confirmed){
            return false
        }

        const confirmedAgain = await alertConfirm(language.emptyTrashConfirm2)
        if(!confirmedAgain){
            return false
        }

        db.characters = db.characters.filter((character) => !character.trashTime)
        checkCharOrder()
        requiresFullEncoderReload.state = true
        selectedCharID.set(-1)
        await requestImmediateSave({ characterIds: trashedCharacterIds })
        notifySuccess(language.trashEmptied.replace('{count}', trashedCount.toString()))
        return true
    }
    finally{
        emptyingCharacterTrash = false
    }
}

export async function addCharacter(arg:{
    reseter?:()=>any,
} = {}){
    const r = await alertAddCharacter()
    let characterId: string | undefined
    switch(r){
        case 'importFromRealm':
            selectedCharID.set(-1)
            OpenRealmStore.set(true)
            return
        case 'createfromScratch': {
            const character = createBlankChar()
            getDatabase().characters.push(character)
            checkCharOrder()
            characterId = character.chaId
            break
        }
        case 'importCharacter':
            characterId = await importCharactersAndPackages()
            break
        default:
            return
    }
    if(characterId) changeChar(characterId, arg)
}

export function changeChar(characterId: string, arg:{
    reseter?:()=>any,
} = {}): boolean {
    const characters = getDatabase().characters
    const index = characters.findIndex(character => character.chaId === characterId && !character.trashTime)
    if(index === -1) return false
    const char = characters[index]
    dismissClaimedLoadingOverlay()
    arg.reseter?.()
    chatDeselected.set(false)
    characterFormatUpdate(index);
    selectedCharID.set(index);
    const chat = getCurrentChat()
    if(chat){
        if(chat._placeholder){
            hydrateSelectedChat(char, getChatPage(char), 'selectCharacter')
        } else {
            loadTogglesFromChat(chat)
        }
    }
    return true
}
