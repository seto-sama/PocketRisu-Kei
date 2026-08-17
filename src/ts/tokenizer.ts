import type { Tiktoken } from "@dqbd/tiktoken";
import type { Tokenizer } from "@mlc-ai/web-tokenizers";
import { type character, type Chat, getCurrentCharacter } from "./storage/database.svelte";
import type { MultiModal, OpenAIChat } from "./process/index.svelte";
import { supportsInlayImage } from "./process/files/inlays";
import { risuChatParser } from "./parser/parser.svelte";
import { getGenerationModelPreset, getModelPresetTokenizer } from "./process/models/modelString";
import type { RegistryTokenizer } from "./preset/types";
import type { GemmaTokenizer } from "@huggingface/transformers";
import { LRUMap } from 'mnemonist';
import { makeHashedStorageKey, readPersistentJson, writePersistentJson } from "./storage/persistentKv";

const MAX_CACHE_SIZE = 1500;

const encodeCache = new LRUMap<string, number[] | Uint32Array | Int32Array>(MAX_CACHE_SIZE);

function getHash(
    data: string,
    tokenizer: RegistryTokenizer,
): string {
    return `${data}::${tokenizer}`;
}


export const tokenizerList = [
    ['tik', 'Tiktoken (OpenAI)'],
    ['mistral', 'Mistral'],
    ['novelai', 'NovelAI'],
    ['claude', 'Claude'],
    ['llama', 'Llama'],
    ['llama3', 'Llama3'],
    ['novellist', 'Novellist'],
    ['gemma', 'Gemma'],
    ['cohere', 'Cohere'],
    ['deepseek', 'DeepSeek'],
] as const

type RevenantTokenizer = typeof tokenizerList[number][0]

function getEffectiveRevenantTokenizer(): RevenantTokenizer {
    return getModelPresetTokenizer(getGenerationModelPreset('model'))
}

export async function encodeWithTokenizer(data: string, tokenizerType: string): Promise<(number[] | Uint32Array | Int32Array)> {
    switch (tokenizerType) {
        case 'tik':
            return await tikJS(data, 'cl100k_base');
        case 'mistral':
            return await tokenizeWebTokenizers(data, 'mistral');
        case 'novelai':
            return await tokenizeWebTokenizers(data, 'novelai');
        case 'claude':
            return await tokenizeWebTokenizers(data, 'claude');
        case 'llama':
            return await tokenizeWebTokenizers(data, 'llama');
        case 'llama3':
            return await tokenizeWebTokenizers(data, 'llama3');
        case 'novellist':
            return await tokenizeWebTokenizers(data, 'novellist');
        case 'gemma':
            return await gemmaTokenize(data);
        case 'cohere':
            return await tokenizeWebTokenizers(data, 'cohere');
        case 'deepseek':
            return await tokenizeWebTokenizers(data, 'DeepSeek');
        default:
            return await tikJS(data, 'cl100k_base');
    }
}

export async function encode(data:string):Promise<(number[]|Uint32Array|Int32Array)>{
    const tokenizer = getEffectiveRevenantTokenizer()
    const cacheKey = getHash(data, tokenizer)
    const cachedResult = encodeCache.get(cacheKey);
    if (cachedResult !== undefined) {
        return cachedResult;
    }

    const result = await encodeWithTokenizer(data, tokenizer)
    encodeCache.set(cacheKey, result);

    return result;
}

type tokenizerType = 'novellist'|'claude'|'novelai'|'llama'|'mistral'|'llama3'|'gemma'|'cohere'|'googleCloud'|'DeepSeek'

const tikParsers = new Map<string, Promise<Tiktoken>>()
const tokenizersByType = new Map<tokenizerType, Promise<Tokenizer>>()

let gemmaTokenizer:GemmaTokenizer = null
async function gemmaTokenize(text:string) {
    if(!gemmaTokenizer){
        const {GemmaTokenizer} = await import('@huggingface/transformers')
        gemmaTokenizer = new GemmaTokenizer(
            await (await fetch("/token/llama/llama3.json")
        ).json(), {})
    }
    return gemmaTokenizer.encode(text)
}

async function tikJS(text:string, model='cl100k_base') {
    let parserPromise = tikParsers.get(model)
    if(!parserPromise){
        parserPromise = (async () => {
            const {Tiktoken} = await import('@dqbd/tiktoken')
            if(model === 'o200k_base'){
                const o200k_base = await import("src/etc/o200k_base.json");
                return new Tiktoken(
                    o200k_base.bpe_ranks,
                    o200k_base.special_tokens,
                    o200k_base.pat_str
                );
            }

            const cl100k_base = await import("@dqbd/tiktoken/encoders/cl100k_base.json");
            return new Tiktoken(
                cl100k_base.bpe_ranks,
                cl100k_base.special_tokens,
                cl100k_base.pat_str
            );
        })()
        tikParsers.set(model, parserPromise)
        parserPromise.catch(() => {
            if(tikParsers.get(model) === parserPromise){
                tikParsers.delete(model)
            }
        })
    }

    return (await parserPromise).encode(text)
}

async function tokenizeWebTokenizers(text:string, type:tokenizerType) {
    let tokenizerPromise = tokenizersByType.get(type)
    if(!tokenizerPromise){
        tokenizerPromise = (async () => {
            const webTokenizer = await import('@mlc-ai/web-tokenizers')
            switch(type){
                case "novellist":
                    return await webTokenizer.Tokenizer.fromSentencePiece(
                        await (await fetch("/token/trin/spiece.model")
                    ).arrayBuffer())
                case "claude":
                    return await webTokenizer.Tokenizer.fromJSON(
                        await (await fetch("/token/claude/claude.json")
                    ).arrayBuffer())
                case 'llama3':
                    return await webTokenizer.Tokenizer.fromJSON(
                        await (await fetch("/token/llama/llama3.json")
                    ).arrayBuffer())
                case 'cohere':
                    return await webTokenizer.Tokenizer.fromJSON(
                        await (await fetch("/token/cohere/tokenizer.json")
                    ).arrayBuffer())
                case 'novelai':
                    return await webTokenizer.Tokenizer.fromSentencePiece(
                        await (await fetch("/token/nai/nerdstash_v2.model")
                    ).arrayBuffer())
                case 'llama':
                    return await webTokenizer.Tokenizer.fromSentencePiece(
                        await (await fetch("/token/llama/llama.model")
                    ).arrayBuffer())
                case 'mistral':
                    return await webTokenizer.Tokenizer.fromSentencePiece(
                        await (await fetch("/token/mistral/tokenizer.model")
                    ).arrayBuffer())
                case 'gemma':
                    return await webTokenizer.Tokenizer.fromSentencePiece(
                        await (await fetch("/token/gemma/tokenizer.model")
                    ).arrayBuffer())
                case 'DeepSeek':
                    return await webTokenizer.Tokenizer.fromJSON(
                        await (await fetch("/token/deepseek/tokenizer.json")
                    ).arrayBuffer())

            }
            throw new Error(`Unknown tokenizer type: ${type}`)
        })()
        tokenizersByType.set(type, tokenizerPromise)
        tokenizerPromise.catch(() => {
            if(tokenizersByType.get(type) === tokenizerPromise){
                tokenizersByType.delete(type)
            }
        })
    }
    return (await tokenizerPromise).encode(text)
}

export async function tokenizerChar(char:character) {
    const encoded = await encode(char.name + '\n' + char.firstMessage + '\n' + char.desc)
    return encoded.length
}

export async function tokenize(data:string) {
    const encoded = await encode(data)
    return encoded.length
}

export async function tokenizeAccurate(data:string | null | undefined, consistantChar?:boolean) {
    data = risuChatParser((data ?? '').replace('{{slot}}',''), {
        tokenizeAccurate: true,
        consistantChar: consistantChar,
    })
    const encoded = await encode(data)
    return encoded.length
}


export class ChatTokenizer {

    private chatAdditionalTokens:number
    private useName:'name'|'noName'
    private tokenizerOverride?: string

    constructor(chatAdditionalTokens:number, useName:'name'|'noName', tokenizerOverride?: string){
        this.chatAdditionalTokens = chatAdditionalTokens
        this.useName = useName
        this.tokenizerOverride = tokenizerOverride
    }
    getRevenantSpec(){
        return {
            chatAdditionalTokens: this.chatAdditionalTokens,
            useName: this.useName,
            tokenizer: this.tokenizerOverride || getEffectiveRevenantTokenizer(),
        }
    }
    private encodeText(data: string) {
        return this.tokenizerOverride
            ? encodeWithTokenizer(data, this.tokenizerOverride)
            : encode(data)
    }
    async tokenizeChat(data:OpenAIChat, args:{
        countThoughts?:boolean,
    } = {}) {
        let encoded = (await this.encodeText(data.content)).length + this.chatAdditionalTokens
        if(data.name && this.useName ==='name'){
            encoded += (await this.encodeText(data.name)).length + 1
        }
        if(data.multimodals && data.multimodals.length > 0){
            for(const multimodal of data.multimodals){
                encoded += await this.tokenizeMultiModal(multimodal)
            }
        }
        if(data.thoughts && data.thoughts.length > 0 && args.countThoughts){
            for(const thought of data.thoughts){
                encoded += (await this.encodeText(thought)).length + 1
            }
        }
        return encoded
    }
    async tokenizeChats(data:OpenAIChat[]){
        let encoded = 0
        for(const chat of data){
            encoded += await this.tokenizeChat(chat)
        }
        return encoded
    }

    tokenizeMultiModal(data:MultiModal){
        if(!supportsInlayImage()){
            return this.chatAdditionalTokens
        }
        if(getGenerationModelPreset('model')?.gptVisionQuality === 'low'){
            return 87
        }

        let encoded = this.chatAdditionalTokens
        let height = data.height ?? 0
        let width = data.width ?? 0

        if(height === width){
            if(height > 768){
                height = 768
                width = 768
            }
        }
        else if(height > width){
            if(width > 768){
                width = 768
                height = height * (768 / width)
            }
        }
        else{
            if(height > 768){
                height = 768
                width = width * (768 / height)
            }
        }

        const chunkSize = Math.ceil(width / 512) * Math.ceil(height / 512)
        encoded += chunkSize * 2
        encoded += 85

        return encoded
    }
    
}

export async function tokenizeNum(data:string) {
    const encoded = await encode(data)
    return encoded
}

const strongBanCache = new Map<string, {[key:number]:number}>();
const strongBanCachePrefix = 'cache/strong-ban/';

async function getPersistedStrongBan(cacheKey: string) {
    if (strongBanCache.has(cacheKey)) {
        return strongBanCache.get(cacheKey)
    }
    const storageKey = await makeHashedStorageKey(strongBanCachePrefix, cacheKey)
    const payload = await readPersistentJson<{ key: string, value: {[key:number]:number} }>(storageKey)
    if (!payload || payload.key !== cacheKey) {
        return null
    }
    strongBanCache.set(cacheKey, payload.value)
    return payload.value
}

export async function strongBan(data:string, bias:{[key:number]:number}) {

    const cacheKey = 'strongBan_' + data
    const cached = await getPersistedStrongBan(cacheKey)
    if(cached){
        return cached
    }
    const performace = performance.now()
    const length = Object.keys(bias).length
    let charAlt = [
        data,
        data.trim(),
        data.toLocaleUpperCase(),
        data.toLocaleLowerCase(),
        data[0].toLocaleUpperCase() + data.slice(1),
        data[0].toLocaleLowerCase() + data.slice(1),
    ]

    let banChars = " !\"#$%&'()*+,-./:;<=>?@[\\]^_`{|}~“”‘’«»「」…–―※"
    let unbanChars:number[] = []

    for(const char of banChars){
        unbanChars.push((await tokenizeNum(char))[0])
    }



    for(const char of banChars){
        const encoded = await tokenizeNum(char)
        if(encoded.length > 0){
            if(!unbanChars.includes(encoded[0])){
                bias[encoded[0]] = -100
            }
        }
        for(const alt of charAlt){
            let fchar = char

            const encoded = await tokenizeNum(alt + fchar)
            if(encoded.length > 0){
                if(!unbanChars.includes(encoded[0])){
                    bias[encoded[0]] = -100
                }
            }
            const encoded2 = await tokenizeNum(fchar + alt)
            if(encoded2.length > 0){
                if(!unbanChars.includes(encoded2[0])){
                    bias[encoded2[0]] = -100
                }
            }
        }
    }
    strongBanCache.set(cacheKey, bias)
    const storageKey = await makeHashedStorageKey(strongBanCachePrefix, cacheKey)
    await writePersistentJson(storageKey, {
        key: cacheKey,
        value: bias
    })
    return bias
}

export async function getCharToken(char?:character|null){
    let persistant = 0
    let dynamic = 0

    if(!char){
        const c = getCurrentCharacter()
        char = c
    }
    const basicTokenize = async (data:string) => {
        data = data.replace(/{{char}}/g, char.name).replace(/<char>/g, char.name)
        return await tokenize(data)
    }

    persistant += await basicTokenize(char.desc)
    persistant += await basicTokenize(char.personality ?? '')
    persistant += await basicTokenize(char.scenario ?? '')
    for(const lore of char.globalLore){
        let cont = lore.content.split('\n').filter((line) => {
            if(line.startsWith('@@')){
                return false
            }
            if(line === ''){
                return false
            }
            return true
        }).join('\n')
        dynamic += await basicTokenize(cont)
    }

    return {persistant, dynamic}
}

export async function getChatToken(chat:Chat) {
    let persistant = 0

    const chatTokenizer = new ChatTokenizer(0, 'name')
    const chatf = chat.message.map((d) => {
        return {
            role: d.role === 'user' ? 'user' : 'assistant',
            content: d.data,
        } as OpenAIChat
    })
    for(const chat of chatf){
        persistant += await chatTokenizer.tokenizeChat(chat)
    }

    return persistant
}
