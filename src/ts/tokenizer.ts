import type { Tiktoken } from "@dqbd/tiktoken";
import type { Tokenizer } from "@huggingface/tokenizers";
import { type character, type Chat, getCurrentCharacter } from "./storage/database.svelte";
import type { MultiModal, OpenAIChat } from "./process/index.svelte";
import { supportsInlayImage } from "./process/files/inlays";
import { risuChatParser } from "./parser/parser.svelte";
import { getGenerationModelPreset, getModelPresetTokenizer } from "./process/models/modelString";
import type { RegistryTokenizer } from "./preset/types";
import { makeHashedStorageKey, readPersistentJson, writePersistentJson } from "./storage/persistentKv";

const MAX_CACHE_SIZE = 1500;
type EncodedTokens = number[] | Uint32Array | Int32Array;

const encodeCache = new Map<string, EncodedTokens>();

function getCachedEncoding(key: string): EncodedTokens | undefined {
    const value = encodeCache.get(key);
    if (value === undefined) return undefined;

    encodeCache.delete(key);
    encodeCache.set(key, value);
    return value;
}

function setCachedEncoding(key: string, value: EncodedTokens): void {
    encodeCache.delete(key);
    encodeCache.set(key, value);

    if (encodeCache.size > MAX_CACHE_SIZE) {
        const oldestKey = encodeCache.keys().next().value;
        if (oldestKey !== undefined) encodeCache.delete(oldestKey);
    }
}

function getHash(
    data: string,
    tokenizer: RegistryTokenizer,
): string {
    return `${data}::${tokenizer}`;
}


export const tokenizerList = [
    ['tik', 'Tiktoken (OpenAI)'],
    ['claude', 'Claude'],
    ['llama3', 'Llama3'],
    ['gemma', 'Gemma'],
    ['deepseek', 'DeepSeek'],
] as const

function getEffectiveRevenantTokenizer(): RegistryTokenizer {
    return getModelPresetTokenizer(getGenerationModelPreset('model'))
}

export async function encodeWithTokenizer(data: string, tokenizerType: string): Promise<EncodedTokens> {
    switch (tokenizerType) {
        case 'tik':
            return await tikJS(data, 'cl100k_base');
        case 'claude':
            return await tokenizeJson(data, 'claude');
        case 'llama3':
            return await tokenizeJson(data, 'llama3');
        case 'gemma':
            return await tokenizeJson(data, 'gemma');
        case 'deepseek':
            return await tokenizeJson(data, 'deepseek');
        // Preserve imported legacy presets without retaining the 4.7 MB WASM
        // runtime needed to read their SentencePiece .model files.
        case 'mistral':
        case 'novelai':
        case 'llama':
        case 'novellist':
            return await tikJS(data, 'cl100k_base');
        default:
            return await tikJS(data, 'cl100k_base');
    }
}

export async function encode(data:string):Promise<EncodedTokens>{
    const tokenizer = getEffectiveRevenantTokenizer()
    const cacheKey = getHash(data, tokenizer)
    const cachedResult = getCachedEncoding(cacheKey);
    if (cachedResult !== undefined) {
        return cachedResult;
    }

    const result = await encodeWithTokenizer(data, tokenizer)
    setCachedEncoding(cacheKey, result);

    return result;
}

type JsonTokenizerType = 'claude'|'llama3'|'gemma'|'deepseek'

const tikParsers = new Map<string, Promise<Tiktoken>>()
const tokenizersByType = new Map<JsonTokenizerType, Promise<Tokenizer>>()

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

async function tokenizeJson(text:string, type:JsonTokenizerType) {
    let tokenizerPromise = tokenizersByType.get(type)
    if(!tokenizerPromise){
        tokenizerPromise = (async () => {
            const { Tokenizer } = await import('@huggingface/tokenizers')
            let path: string
            switch(type){
                case "claude":
                    path = "/token/claude/claude.json"
                    break
                case 'llama3':
                    path = "/token/llama/llama3.json"
                    break
                case 'gemma':
                    path = "/token/gemma/tokenizer.json"
                    break
                case 'deepseek':
                    path = "/token/deepseek/tokenizer.json"
                    break
            }
            const config = await (await fetch(path)).json()
            return new Tokenizer(config, {})
        })()
        tokenizersByType.set(type, tokenizerPromise)
        tokenizerPromise.catch(() => {
            if(tokenizersByType.get(type) === tokenizerPromise){
                tokenizersByType.delete(type)
            }
        })
    }
    return (await tokenizerPromise).encode(text, { add_special_tokens: false }).ids
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
