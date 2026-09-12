import { tokenizeAccurate } from "../tokenizer";
import type { botPreset } from "../storage/database.svelte";
import type { OobaChatCompletionRequestParams } from "../model/ooba";

export type PromptItem = PromptItemPlain|PromptItemTyped|PromptItemChat|PromptItemAuthorNote|PromptItemChatML|PromptItemCache
export type PromptType = PromptItem['type'];
export type PromptSettings = {
    assistantPrefill: string
    postEndInnerFormat: string
    sendChatAsSystem: boolean
    sendName: boolean
    utilOverride: boolean
    customChainOfThought?: boolean
    maxThoughtTagDepth?: number
    trimStartNewChat?: boolean
}

export type PromptRole = 'user'|'bot'|'system'

export interface PromptItemPlain {
    type: 'plain'|'jailbreak'|'cot';
    type2: 'normal'|'globalNote'|'main'
    text: string;
    role: PromptRole;
    name?: string
}

export interface PromptItemChatML {
    type: 'chatML'
    text: string
    name?: string
}

export interface PromptItemTyped {
    type: 'persona'|'description'|'lorebook'|'postEverything'|'memory'
    innerFormat?: string,
    role?: PromptRole
    name?: string
}

export interface PromptItemAuthorNote {
    type : 'authornote'
    innerFormat?: string
    defaultText?: string
    role?: PromptRole
    name?: string
}


export interface PromptItemChat {
    type: 'chat';
    rangeStart: number;
    rangeEnd: number|'end';
    chatAsOriginalOnSystem?: boolean;
    name?: string
}

export interface PromptItemCache {
    type: 'cache';
    name: string
    depth: number
    role: 'user'|'assistant'|'system'|'all'

}

export async function tokenizePreset(prompts:PromptItem[], consti:boolean = false){
    let total = 0
    for(const prompt of prompts){
        switch(prompt.type){
            case 'plain':
            case 'jailbreak':{
                total += await tokenizeAccurate(prompt.text, consti)
                break
            }
            case 'persona':
            case 'description':
            case 'lorebook':
            case 'postEverything':
            case 'authornote':
            case 'memory':{
                if(prompt.innerFormat){
                    total += await tokenizeAccurate(prompt.innerFormat, consti)
                }
                break
            }
        }
    }
    return total
}

function normalizeImportedPromptRole(role: unknown): PromptRole {
    if(role === 'user' || role === 'bot' || role === 'system'){
        return role
    }
    if(role === 'assistant' || role === 'char'){
        return 'bot'
    }
    return 'system'
}

export function detectPromptJSONType(text:string){

    function notNull<T>(x:T|null):x is T{
        return x !== null && x !== undefined
    }

    try {
        const parsed = JSON.parse(text)
        if(notNull(parsed.chat_completion_source) && Array.isArray(parsed.prompts)&& Array.isArray(parsed.prompt_order)){
            return "STCHAT"
        }
        else if(notNull(parsed.temp) && notNull(parsed.rep_pen) && notNull(parsed.min_length)){
            return "PARAMETERS"
        }
    } catch (e) {}
    return 'NOTSUPPORTED'
}

const typePriority = [
    'PARAMETERS',
    'STCHAT',
]

export function stChatConvert(pre:any){
    //ST preset
    let promptTemplate = []

    function findPrompt(identifier:number){
        return pre.prompts.find((p:any) => p.identifier === identifier)
    }

    for(const prompt of pre?.prompt_order?.[0]?.order ?? []){
        if(!prompt?.enabled){
            continue
        }
        const p = findPrompt(prompt?.identifier ?? '')
        if(p){
            switch(p.identifier){
                case 'main':{
                    promptTemplate.push({
                        type: 'plain',
                        type2: 'main',
                        text: p.content ?? "",
                        role: normalizeImportedPromptRole(p.role)
                    })
                    break
                }
                case 'jailbreak':
                case 'nsfw':{
                    promptTemplate.push({
                        type: 'jailbreak',
                        type2: 'normal',
                        text: p.content ?? "",
                        role: normalizeImportedPromptRole(p.role)
                    })
                    break
                }
                case 'dialogueExamples':
                case 'charPersonality':
                case 'scenario':{
                    break //ignore
                }
                case 'chatHistory':{
                    promptTemplate.push({
                        type: 'chat',
                        rangeEnd: 'end',
                        rangeStart: 0
                    })
                    break
                }
                case 'worldInfoBefore':{
                    promptTemplate.push({
                        type: 'lorebook'
                    })
                    break
                }
                case 'worldInfoAfter':{
                    break
                }
                case 'charDescription':{
                    promptTemplate.push({
                        type: 'description'
                    })
                    break
                }
                case 'personaDescription':{
                    promptTemplate.push({
                        type: 'persona'
                    })
                    break
                }
                default:{
                    console.log(p)
                    promptTemplate.push({
                        type: 'plain',
                        type2: 'normal',
                        text: p.content ?? "",
                        role: normalizeImportedPromptRole(p.role)
                    })
                }
            }
        }
        else{
            console.log("Prompt not found", prompt)
        
        }
    }
    if(pre?.assistant_prefill){
        promptTemplate.push({
            type: 'postEverything'
        })
        promptTemplate.push({
            type: 'plain',
            type2: 'main',
            text: `{{#if {{prefill_supported}}}}${pre?.assistant_prefill}{{/if}}`,
            role: 'bot'
        })
    }

    return promptTemplate
}

export const OobaParams = [
    "tokenizer",
    "min_p",
    "top_k",
    "repetition_penalty",
    "repetition_penalty_range",
    "typical_p",
    "tfs",
    "top_a",
    "epsilon_cutoff",
    "eta_cutoff",
    "guidance_scale",
    "negative_prompt",
    "penalty_alpha",
    "mirostat_mode",
    "mirostat_tau",
    "mirostat_eta",
    "temperature_last",
    "do_sample",
    "seed",
    "encoder_repetition_penalty",
    "no_repeat_ngram_size",
    "min_length",
    "num_beams",
    "length_penalty",
    "early_stopping",
    "truncation_length",
    "max_tokens_second",
    "custom_token_bans",
    "auto_max_new_tokens",
    "ban_eos_token",
    "add_bos_token",
    "skip_special_tokens",
    "grammar_string"
]

export type PromptConversionFile = {
    name: string
    content: string
    type: string
}

export function convertPromptFiles(files:PromptConversionFile[], presetTemplate:botPreset):botPreset{
    let preset = structuredClone(presetTemplate)
    preset.name = ''

    let type = ''

    files = files.filter(x=>x.type !== 'NOTSUPPORTED').sort((a,b)=>{
        return typePriority.indexOf(a.type) - typePriority.indexOf(b.type)
    })

    if(files.length === 0){
        throw new Error('Unsupported prompt preset format.')
    }


    if(files.findIndex(x=>x.type === 'STCHAT') !== -1){
        type = 'STCHAT'
    }

    let samplers:string[] = []

    let oobaData:OobaChatCompletionRequestParams = {
        mode: 'instruct',
    }


    for(let i=0;i<files.length;i++){
        const file = files[i]
        const data = JSON.parse(file.content)

        const getParam = (setname:keyof(typeof preset), getname:string = '', arg:{
            multiplier?: number
        }={}) => {
            if(getname === ''){
                getname = setname
            }
            let multiplier = arg.multiplier ?? 1
            if(samplers.includes(getname)){
                //@ts-expect-error dynamic key access on preset with value from parsed JSON
                preset[setname] = data[getname] * multiplier
            }
            else{
                //@ts-expect-error dynamic key assignment to preset, -1000 indicates unset sampler
                preset[setname] = -1000
            }
    
            if(OobaParams.includes(getname)){
                oobaData[getname] = data[getname]
            }
        }

        switch(file.type){
            case 'PARAMETERS':{
                samplers = Array.isArray(data.samplers) ? data.samplers : []
                getParam('temperature', 'temp', {multiplier: 100})
                getParam('top_p')
                getParam('top_k')
                getParam('top_a')
                getParam('min_p')
                getParam('repetition_penalty', 'rep_pen')
                getParam('frequencyPenalty', 'freq_pen', {multiplier: 100})
                getParam('PresensePenalty', 'presence_penalty', {multiplier: 100})
                for(const key of OobaParams){
                    if(samplers.includes(key) && (data[key] !== undefined) && (data[key] !== null)){
                        oobaData[key] = data[key]
                    }
                }
                break
            }
            case 'STCHAT':{
                samplers = Object.keys(data)
                getParam('temperature', 'temperature', {multiplier: 100})
                getParam('top_p')
                getParam('top_k')
                getParam('top_a')
                getParam('min_p')
                getParam('repetition_penalty', 'repetition_penalty')
                getParam('frequencyPenalty', 'frequency_penalty', {multiplier: 100})
                getParam('PresensePenalty', 'presence_penalty', {multiplier: 100})
                const prompts = stChatConvert(data)
                preset.promptTemplate = prompts
                preset.name ||= data.name || 'Imported ST Preset'
            }
        }
    }

    if(type === 'STCHAT'){
        return preset
    }

    preset.reverseProxyOobaArgs = oobaData

    preset.promptTemplate = [{
        type: 'plain',
        type2: 'main',
        text: '',
        role: 'system'
    },{
        type: 'description',
    },{
        type: 'persona',
    },{
        type: 'lorebook',
    },{
        type: 'chat',
        rangeStart: 0,
        rangeEnd: 'end',
    }, {
        type: 'authornote',
        role: 'system',
    }, {
        type: 'plain',
        type2: 'globalNote',
        text: '',
        role: 'system'
    }]


    
    preset.name ||= 'Converted from JSON'
    return preset
}
