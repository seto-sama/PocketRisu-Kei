import { isDebugEnabled } from 'src/ts/debug'
import { getChatPage } from 'src/ts/storage/chatSelection.svelte'
import { Buffer } from 'buffer'
import { get } from "svelte/store";
import { selectedCharID } from "../stores.svelte";
import { type character, type customscript, getDatabase, getCurrentCharacter, getCurrentChat } from "../storage/database.svelte";
import { downloadFile } from "../globalApi.svelte";
import { alertError, notifySuccess } from "../alert";
import { language } from "src/lang";
import { selectSingleImportFile } from "../util";
import { type CbsConditions, risuChatParser as risuChatParserOrg, type simpleCharacterArgument } from "../parser/parser.svelte";
import { getModuleRegexScripts, getModuleTriggers } from "./modules";
import { hasLuaEditListener, runLuaEditTrigger } from "./scriptings";
import { pluginRuntime } from "../plugins/pluginRuntime";
import { runTrigger } from "./triggers";
import { applyRegexScripts, type ScriptMode } from "./regexScriptCore";

export type { ScriptMode }

export async function processScript(char:character, data:string, mode:ScriptMode, cbsConditions:CbsConditions = {}){
    return (await processScriptFull(char, data, mode, -1, cbsConditions)).data
}

export function exportRegex(script:customscript[]){
    const data = Buffer.from(JSON.stringify({
        type: 'regex',
        data: script
    }), 'utf-8')
    downloadFile(`regexscript_export.json`,data)
    notifySuccess(language.browserDownloadStarted)
}

export async function importRegex(o:customscript[]):Promise<customscript[]>{
    const filedata = (await selectSingleImportFile())?.data
    if(!filedata){
        return o
    }
    try {
        const imported= JSON.parse(Buffer.from(filedata).toString('utf-8'))
        if(imported.type === 'regex' && imported.data){
            const datas:customscript[] = imported.data
            const script = o
            for(const data of datas){
                script.push(data)
            }
            return o
        }
        else{
            alertError("File invaid or corrupted")
        }

    } catch (error) {
        alertError(error)
    }
    return o
}

let processScriptCache = new Map<string, string>()

function generateScriptCacheKey(scripts: customscript[], data: string, mode: ScriptMode, chatID = -1, cbsConditions: CbsConditions = {}) {
    let hash = data + '|||' + mode + '|||';
    for (const script of scripts) {
        if(script.type !== mode){
            continue
        }
        hash += `${script.flag?.includes('<cbs>') ? risuChatParser(script.in, { chatID: chatID, cbsConditions }) : script.in}|||${script.out}${chatID}|||${script.flag ?? ''}|||${script.ableFlag ? 1 : 0}`;
    }
    return hash;
}

function cacheScript(hash:string, result:string){
    processScriptCache.set(hash, result)

    if(processScriptCache.size > 1000){
        processScriptCache.delete(processScriptCache.keys().next().value)
    }

}

function getScriptCache(hash:string){
    return processScriptCache.get(hash)
}

export function resetScriptCache(){
    processScriptCache = new Map()
}

export async function processScriptFull(char:character|simpleCharacterArgument, data:string, mode:ScriptMode, chatID = -1, cbsConditions:CbsConditions = {}){
    const db = getDatabase()
    if (mode !== 'editprocess' && hasLuaEditListener(char, mode)) {
        data = await runLuaEditTrigger(char, mode, data, { index:chatID })
    }

    if(mode === 'editdisplay'){
        const currentChar = getCurrentCharacter()
        if(currentChar){
            try{
                const perf = isDebugEnabled() ? performance.now() : 0
                const d = await runTrigger(currentChar, 'display', {
                    chat: getCurrentChat(),
                    displayMode: true,
                    displayData: data
                })
    
                data = d?.displayData ?? data
                if (isDebugEnabled()) {
                    console.debug('Trigger time', performance.now() - perf)
                }
            }
            catch(e){
                console.error(e)
            }
        }
    }

    if(pluginRuntime[mode].size > 0){
        for(const plugin of pluginRuntime[mode]){
            const res = await plugin(data)
            if(res !== null && res !== undefined){
                data = res
            }
        }
    }

    data = risuChatParser(data, { chatID: chatID, cbsConditions })
    const scripts = (db.presetRegex ?? []).concat(char.customscript).concat(getModuleRegexScripts())
    const hash = generateScriptCacheKey(scripts, data, mode, chatID, cbsConditions)
    const cached = getScriptCache(hash)
    if(cached){
        return {data: cached}
    }

    if(scripts.length === 0){
        cacheScript(hash, data)
        return {data}
    }
    data = applyRegexScripts(data, scripts, mode, {
        chatID,
        parse: text => risuChatParser(text, { chatID: chatID, cbsConditions }),
        getTarget: () => {
            const selchar = db.characters[get(selectedCharID)]
            return selchar ? { chat: selchar.chats[getChatPage(selchar)], character: selchar } : undefined
        },
        onError: error => console.error(error),
    })
    cacheScript(hash, data)

    return {data}
}


export const risuChatParser = risuChatParserOrg

// A chat bubble's display text. Raw-text LLM translation keys on it, so the
// HypaV3 views rebuild it with the same arguments to share that cache.
export function parseChatDisplayMessage(data: string, arg: {
    name: string
    chatID: number
    cbsConditions: CbsConditions
}): string {
    return risuChatParserOrg(data, {
        chara: arg.name,
        chatID: arg.chatID,
        rmVar: true,
        visualize: true,
        cbsConditions: arg.cbsConditions,
    })
}
