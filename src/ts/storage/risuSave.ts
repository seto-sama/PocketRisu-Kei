import { importPromptPresetSelection } from '../../../shared/promptPresetSelection.mjs'
import { Packr, Unpackr } from "msgpackr/index-no-eval";
import type { Database } from "./database.svelte";
import { chatToStub } from '../../../shared/chatShape.mjs'
import {
    characterToClientWriteShape,
    characterToPersistentShape,
    characterWithServerBaseline,
    rootValueToClientWriteShape,
    rootValueWithServerBaseline,
} from './persistenceShape';

const packr = new Packr({
    useRecords:false
});

const unpackr = new Unpackr({
    int64AsType: 'number',
    useRecords:false
})

const magicHeader = new Uint8Array([0, 82, 73, 83, 85, 83, 65, 86, 69, 0, 7]); 
const magicCompressedHeader = new Uint8Array([0, 82, 73, 83, 85, 83, 65, 86, 69, 0, 8]);
const magicStreamCompressedHeader = new Uint8Array([0, 82, 73, 83, 85, 83, 65, 86, 69, 0, 9]);
const magicRisuSaveHeader = new TextEncoder().encode("RISUSAVE\0");


export function encodeRisuSaveLegacy(data:any){
    const encoded:Uint8Array = packr.encode(data)
    const result = new Uint8Array(encoded.length + magicHeader.length);
    result.set(magicHeader, 0)
    result.set(encoded, magicHeader.length)
    return result
}

export type toSaveType = {
    character: string[];
    chat: [string, string][];
    root: boolean;
    botPreset: boolean;
    modules: boolean;
    plugins: boolean;
    pluginCustomStorage: boolean;
}

enum RisuSaveType {
    CONFIG = 0,
    ROOT = 1,
    CHARACTER_WITH_CHAT = 2,
    CHAT = 3,
    BOTPRESET = 4,
    MODULES = 5,
    UNSUPPORTED_REMOTE = 6,
    CHARACTER_WITHOUT_CHAT = 7,
    ROOT_COMPONENT = 8,
    PLUGINS = 9,
    LOADOUTS = 10,
    PLUGIN_STORAGE = 11,
    /** Reserved: upstream SaveKV namespace block, skipped by the server decoder */
    UNSUPPORTED_KV = 12,
}

type EncodeBlockArg = {
    data:string
    type:RisuSaveType
    name:string
}

function serializeRootValues(data: Database): Record<string, unknown> {
    const root: Record<string, unknown> = {}
    for (const key of Object.keys(data)) {
        if (
            key !== 'characters' && key !== 'botPresets' && key !== 'modules' &&
            key !== 'plugins' && key !== 'pluginCustomStorage'
        ) {
            root[key] = rootValueToClientWriteShape(key, data[key])
        }
    }
    return root
}

function serializeCharacterBlock(character: Database['characters'][number]): string {
    const charForEncode = {
        ...characterToClientWriteShape(character),
        chats: character.chats.map(chat => chatToStub(chat)),
    }
    // Keep serialization strict so circular data fails the save.
    return JSON.stringify(charForEncode)
}

export class RisuSaveEncoder {

    private blocks: { [key: string]: Uint8Array } = {};
    // Retain each character's JSON to avoid encoding unchanged blocks again.
    private characterJsons: { [key: string]: string } = {};

    async init(data:Database){
        const obj = serializeRootValues(data)
        this.blocks['root'] = this.encodeBlock({
            data: JSON.stringify(obj),
            type: RisuSaveType.ROOT,
            name: 'root'
        });
        this.blocks['preset'] = this.encodeBlock({
            data: JSON.stringify(data.botPresets),
            type: RisuSaveType.BOTPRESET,
            name: 'preset'
        });
        this.blocks['modules'] = this.encodeBlock({
            data: JSON.stringify(data.modules),
            type: RisuSaveType.MODULES,
            name: 'modules'
        });
        this.blocks['plugins'] = this.encodeBlock({
            data: JSON.stringify(data.plugins),
            type: RisuSaveType.PLUGINS,
            name: 'plugins'
        });
        this.blocks['pluginStorage'] = this.encodeBlock({
            data: JSON.stringify(data.pluginCustomStorage),
            type: RisuSaveType.PLUGIN_STORAGE,
            name: 'pluginStorage'
        });
        this.characterJsons = {}
        for( const character of data.characters) {
            const charJson = serializeCharacterBlock(character)
            this.blocks[character.chaId] = this.encodeBlock({
                data: charJson,
                type: RisuSaveType.CHARACTER_WITH_CHAT,
                name: character.chaId
            });
            this.characterJsons[character.chaId] = charJson
        }
        this.blocks['config'] = this.encodeBlock({
            data: JSON.stringify({
                version: 1
            }),
            type: RisuSaveType.CONFIG,
            name: "config"
        })
    }

    async set(data:Database, toSave:toSaveType){
        const obj = serializeRootValues(data)

        for(const character of data.characters) {
            if (!character?.chaId) {
                continue
            }
            const chaId = character.chaId
            const charJson = serializeCharacterBlock(character)
            const hasChanged = this.characterJsons[chaId] !== charJson

            if (hasChanged || !this.blocks[chaId]) {
                this.blocks[chaId] = this.encodeBlock({
                    data: charJson,
                    type: RisuSaveType.CHARACTER_WITH_CHAT,
                    name: character.chaId
                });
                this.characterJsons[chaId] = charJson
            }
        }

        // Ensure stale character blocks are always removed even when deletion wasn't tracked in toSave.
        // This prevents deleted characters from being resurrected after full-write fallback.
        const currentCharacterIds = new Set<string>((data.characters ?? []).map((character) => character?.chaId).filter(Boolean));
        for (const key of Object.keys(this.blocks)) {
            if (key === 'root' || key === 'preset' || key === 'modules' || key === 'config'
                || key === 'plugins' || key === 'pluginStorage') {
                continue;
            }
            if (!currentCharacterIds.has(key)) {
                delete this.blocks[key];
                delete this.characterJsons[key];
            }
        }

        if(toSave.botPreset){
            this.blocks['preset'] = this.encodeBlock({
                data: JSON.stringify(data.botPresets),
                type: RisuSaveType.BOTPRESET,
                name: 'preset'
            });
        }
        if(toSave.modules){
            this.blocks['modules'] = this.encodeBlock({
                data: JSON.stringify(data.modules),
                type: RisuSaveType.MODULES,
                name: 'modules'
            });
        }

        if(toSave.pluginCustomStorage){
            this.blocks['pluginStorage'] = this.encodeBlock({
                data: JSON.stringify(data.pluginCustomStorage),
                type: RisuSaveType.PLUGIN_STORAGE,
                name: 'pluginStorage'
            });
        }

        if(toSave.plugins){
            this.blocks['plugins'] = this.encodeBlock({
                data: JSON.stringify(data.plugins),
                type: RisuSaveType.PLUGINS,
                name: 'plugins'
            });
        }

        obj["__directory"] = Object.keys(this.blocks).filter(key => key !== 'root');
        this.blocks['root'] = this.encodeBlock({
            data: JSON.stringify(obj),
            type: RisuSaveType.ROOT,
            name: 'root'
        });
    }

    encode(){
        if(!this.blocks['config']){
            return null
        }
        let totalLength = 0
        for(const key in this.blocks){
            totalLength += this.blocks[key].length;
        }
        totalLength += magicRisuSaveHeader.length;
        const arrayBuf = new ArrayBuffer(totalLength);
        const view = new Uint8Array(arrayBuf);
        let offset = 0;
        view.set(magicRisuSaveHeader, offset);
        offset += magicRisuSaveHeader.length;
        for(const key in this.blocks){
            view.set(this.blocks[key], offset);
            offset += this.blocks[key].length;
        }
        return arrayBuf;
    }

    encodeBlock(arg:EncodeBlockArg): Uint8Array {
        const databuf = new TextEncoder().encode(arg.data);
        const nameBuf = new TextEncoder().encode(arg.name);
        const lengthBuf = new ArrayBuffer(4);
        new Uint32Array(lengthBuf)[0] = databuf.length;
        const arrayBuf = new ArrayBuffer(2 + 1 + nameBuf.length + 4 + databuf.length);
        const buf = new Uint8Array(arrayBuf);
        buf.set(new Uint8Array([arg.type, 0]), 0);
        buf.set(new Uint8Array([nameBuf.length]), 2);
        buf.set(nameBuf, 3);
        buf.set(new Uint8Array(lengthBuf), 3 + nameBuf.length);
        buf.set(databuf, 7 + nameBuf.length);
        return buf;
    }

}

export async function decodeRisuSave(data:Uint8Array){
    return importPromptPresetSelection(await decodeRisuSaveInternal(data))
}

async function decodeRisuSaveInternal(data:Uint8Array){
    let header: ReturnType<typeof checkHeader> = false
    try {
        header = checkHeader(data)
        switch(header){
            case "compressed":
                return await decodeSaveFile(data)
            case "raw":
                data = data.slice(magicHeader.length)
                return unpackr.decode(data)
            case "stream":
                return await decodeSaveFile(data)
            case "risusave":{
                return await decodeSaveFile(data)
            }
        }
        return unpackr.decode(data)
    }
    catch (error) {
        if(header === 'compressed' || header === 'stream' || header === 'risusave') throw error
        console.error('Error decoding RisuSave data:', error);
        try {
            const risuSaveHeader = new TextEncoder().encode("\u0000\u0000RISU")
            const realData = data.subarray(risuSaveHeader.length)
            const dec = unpackr.decode(realData)
            return dec   
        } catch (error) {
            return await decodeSaveFile(data)
        }
    }
}

async function decodeSaveFile(data:Uint8Array):Promise<Database>{
    const { forageStorage } = await import('./autoStorage')
    return await forageStorage.decodeFile('save', data) as Database
}

function checkHeader(data: Uint8Array) {

    let header:'none'|'compressed'|'raw'|'stream'|'risusave' = 'raw'

    if (data.length < magicHeader.length) {
      return false;
    }
  
    for (let i = 0; i < magicHeader.length; i++) {
      if (data[i] !== magicHeader[i]) {
        header = 'none'
        break
      }
    }

    if(header === 'none'){
        header = 'compressed'
        for (let i = 0; i < magicCompressedHeader.length; i++) {
            if (data[i] !== magicCompressedHeader[i]) {
                header = 'none'
                break
            }
        }
    }

    if(header === 'none'){
        header = 'stream'
        for (let i = 0; i < magicStreamCompressedHeader.length; i++) {
            if (data[i] !== magicStreamCompressedHeader[i]) {
                header = 'none'
                break
            }
        }
    }

    if(header === 'none'){
        header = 'risusave'
        for (let i = 0; i < magicRisuSaveHeader.length; i++) {
            if (data[i] !== magicRisuSaveHeader[i]) {
                header = 'none'
                break
            }
        }
    }

    return header;
}

const PRIME_MULTIPLIER = 31;

const SEED_OBJECT = 17;
const SEED_ARRAY = 19;
const SEED_STRING = 23;
const SEED_NUMBER = 29;
const SEED_BOOLEAN = 31;
const SEED_NULL = 37;

export function calculateHash(node: any): number {
    if (node === null || node === undefined) return SEED_NULL;
    switch (typeof node) {
        case 'object':
            if (Array.isArray(node)) {
                let arrayHash = SEED_ARRAY;
                for (const item of node)
                    arrayHash = (Math.imul(arrayHash, PRIME_MULTIPLIER) + calculateHash(item)) >>> 0;
                return arrayHash;
            } else {
                // Independent of key order
                let objectHash = SEED_OBJECT;
                for (const key in node)
                    objectHash += (Math.imul(calculateHash(key), PRIME_MULTIPLIER) + calculateHash(node[key]));
                return objectHash >>> 0;
            }
        case 'string':
            let strHash = 2166136261;
            for (let i = 0; i < node.length; i++)
                strHash = Math.imul(strHash ^ node.charCodeAt(i), 16777619);
            return Math.imul(SEED_STRING, PRIME_MULTIPLIER) + (strHash >>> 0);
        case 'number':
            let numHash;
            if (Number.isInteger(node) && node >= -2147483648 && node <= 2147483647)
                numHash = node >>> 0;
            else {
                const str = node.toString();
                numHash = 2166136261;
                for (let i = 0; i < str.length; i++)
                    numHash = Math.imul(numHash ^ str.charCodeAt(i), 16777619);
                numHash = numHash >>> 0;
            }
            return Math.imul(SEED_NUMBER, PRIME_MULTIPLIER) + numHash;
        case 'boolean':
            return Math.imul(SEED_BOOLEAN, PRIME_MULTIPLIER) + (node ? 1 : 0);

        default:
            return 0;
    }
}

export function normalizeJSON(value: any, seen?: WeakSet<object>): any {
    if (value === null || value === undefined) return null;
    if (typeof value !== 'object') {
        if (typeof value === 'number' && !isFinite(value)) return null;
        if (typeof value === 'function' ||
            typeof value === 'symbol' ||
            typeof value === 'bigint')
            return undefined;
        return value;
    }
    if (value instanceof Date) return value.toISOString();
    if (value instanceof RegExp || value instanceof Error) return {};
    if (!seen) seen = new WeakSet();
    if (seen.has(value)) {
        console.warn('[normalizeJSON] Circular reference detected and replaced with null')
        return null;
    }
    seen.add(value);
    if (Array.isArray(value)) {
        const result: any[] = [];
        for (const item of value) {
            if (item === undefined) {
                result.push(null);
            } else {
                const normalized = normalizeJSON(item, seen);
                result.push(normalized === undefined ? null : normalized);
            }
        }
        seen.delete(value);
        return result;
    }
    const result: Record<string, any> = {};
    for (const key in value) {
        if (Object.prototype.hasOwnProperty.call(value, key)) {
            const propValue = value[key];
            if (propValue !== undefined) {
                const normalized = normalizeJSON(propValue, seen);
                if (normalized !== undefined)
                    result[key] = normalized;
            }
        }
    }
    seen.delete(value);
    return result;
}

// Index shifts in deeply nested arrays can generate enormous elementwise diffs.
// Replace structural changes or invalid IDs as a unit; append returned ops without spreading.
function diffArrayWithIdGuard(
    compare: (a: any, b: any) => any[],
    path: string,
    lastArr: any[] | undefined,
    curArr: any[],
    idKey: string,
): any[] {
    const last = lastArr ?? []
    let structural = last.length !== curArr.length

    if (!structural) {
        const lastIds = last.map((m: any) => m?.[idKey])
        const curIds = curArr.map((m: any) => m?.[idKey])
        const hasInvalidIds = curIds.some(id => !id) || lastIds.some(id => !id)
        const hasDuplicates = new Set(curIds).size !== curIds.length
        structural = hasInvalidIds || hasDuplicates ||
            lastIds.some((id, i) => id !== curIds[i])
    }

    if (structural) {
        return [{ op: 'replace', path, value: curArr }]
    }

    const ops: any[] = []
    for (let i = 0; i < curArr.length; i++) {
        const subPatch = compare(last[i], curArr[i])
        for (const p of subPatch) {
            ops.push({ ...p, path: `${path}/${i}${p.path}` })
        }
    }
    return ops
}

export class RisuSavePatcher {
    private lastSyncedDb: any;

    getBaselineSnapshot(): any {
        return structuredClone(this.lastSyncedDb)
    }
    private hashBlocks: { [key: string]: number } = {};
    // An entry whose raw JSON equals its baseline skips normalize, hash and diff; a string
    // compare is far cheaper. Typing changes one root key or module lorebook on every save,
    // so baselines are kept per root key, character and module.
    // Maps, because ids come from importable data: "__proto__" on a plain object would hit
    // the prototype setter and corrupt the skip checks and the modules hash fold, and
    // Map keys keep 1 and "1" apart.
    private lastRootKeyJsons = new Map<string, string>();
    private lastCharJsons = new Map<string, string>();
    private lastModuleJsons = new Map<string, string>();
    private moduleItemHashes = new Map<string, number>();

    hash(): string {
        this.hashBlocks['characters'] = SEED_ARRAY;
        for (const character of this.lastSyncedDb.characters) {
            this.hashBlocks['characters'] = (Math.imul(this.hashBlocks['characters'], PRIME_MULTIPLIER) + this.hashBlocks[character.chaId]) >>> 0;
        }

        const keys = Object.keys(this.lastSyncedDb)
        let rootHash = SEED_OBJECT;
        for (const key of keys) {
            rootHash += (Math.imul(calculateHash(key), PRIME_MULTIPLIER) + this.hashBlocks[key])
        }
        return (rootHash >>> 0).toString(16);
    }

    async init(data: any) {
        this.lastSyncedDb = normalizeJSON(data);
        if (!Array.isArray(this.lastSyncedDb.characters)) {
            this.lastSyncedDb.characters = [];
        }
        this.hashBlocks = {};

        const keys = Object.keys(this.lastSyncedDb)

        for (const key of keys) {
            if (key !== 'characters') {
                this.hashBlocks[key] = calculateHash(this.lastSyncedDb[key]);
            }
        }

        for (let i = 0; i < this.lastSyncedDb.characters.length; i++) {
            const character = this.lastSyncedDb.characters[i];
            // Hash with stubs only (matching set()) so hashes stay in sync
            const withStubs = {
                ...characterToPersistentShape(character),
                chats: (character.chats || []).map((c: any) => chatToStub(c)),
            };
            this.hashBlocks[character.chaId] = calculateHash(withStubs);
            this.lastSyncedDb.characters[i] = withStubs;
        }

        // Baselines hold the normalized form, which is what gets diffed and saved. A raw
        // baseline could equal a later raw value whose normalized form differs (a shared
        // reference normalized to null, then un-shared), and the fast path would skip a real
        // change; with a normalized baseline any such value (shared ref, Date, non-finite)
        // takes the full path.
        const { characters: _c, botPresets: _b, modules: _m, ...normRootOnly } = this.lastSyncedDb
        this.lastRootKeyJsons = new Map();
        for (const key of Object.keys(normRootOnly)) {
            this.lastRootKeyJsons.set(key, JSON.stringify(normRootOnly[key]))
        }
        this.lastCharJsons = new Map();
        for (const character of this.lastSyncedDb.characters) {
            if (character?.chaId) this.lastCharJsons.set(character.chaId, JSON.stringify(character))
        }
        this.lastModuleJsons = new Map();
        this.moduleItemHashes = new Map();
        const normModulesInit = Array.isArray(this.lastSyncedDb.modules) ? this.lastSyncedDb.modules : []
        for (const m of normModulesInit) {
            if (typeof m?.id === 'string' && m.id) {
                this.lastModuleJsons.set(m.id, JSON.stringify(m))
                this.moduleItemHashes.set(m.id, calculateHash(m))
            }
        }
    }

    async set(data: any, toSave: toSaveType): Promise<{ patch: any[] }> {
        const { compare } = await import('fast-json-patch')
        const patch: any[] = []

        const {
            characters: lastCharacters = [],
            botPresets: lastBotPresets,
            modules: lastModules,
            ...lastRoot
        } = this.lastSyncedDb

        const {
            characters: curCharacters = [],
            botPresets: curBotPresets,
            modules: curModules,
            ...curRoot
        } = data
        for (const key of Object.keys(curRoot)) {
            curRoot[key] = rootValueWithServerBaseline(key, curRoot[key], lastRoot[key])
        }

        // Checked per root key: typing into one field (personaPrompt) changes the root on every
        // save, and a whole-root check would re-normalize and re-diff every key each time.
        // Per-key ops equal compare(lastRoot, normRoot), since an object diff recurses per key.
        const nextRoot: any = {}
        const removedRootKeys = new Set(Object.keys(lastRoot))
        for (const key of Object.keys(curRoot)) {
            // The delta rejects prototype paths, so an own '__proto__' key would fail every save;
            // normalizeJSON drops it too, since its assignment hits the prototype setter.
            if (key === '__proto__') continue
            // hasOwn, not `in`: membership must match the baseline's OWN keys
            // (`in` would treat inherited names like 'toString' as present).
            const hadKey = Object.hasOwn(lastRoot, key)
            let curKeyJson: string | undefined
            try { curKeyJson = JSON.stringify(curRoot[key]) } catch { curKeyJson = undefined }
            if (curKeyJson !== undefined && hadKey && curKeyJson === this.lastRootKeyJsons.get(key)) {
                removedRootKeys.delete(key)
                nextRoot[key] = lastRoot[key]
                continue
            }
            // Presence follows normalizeJSON, not JSON.stringify: normalizeJSON ignores toJSON,
            // so {x:1, toJSON:()=>undefined} is present as {x:1}, while bigint, function and
            // symbol values normalize to undefined and their parent drops the key.
            const normVal = normalizeJSON(curRoot[key])
            if (normVal === undefined) continue
            removedRootKeys.delete(key)
            const before = hadKey ? { [key]: lastRoot[key] } : {}
            for (const p of compare(before, { [key]: normVal })) patch.push(p)
            this.hashBlocks[key] = calculateHash(normVal)
            this.lastRootKeyJsons.set(key, JSON.stringify(normVal))
            nextRoot[key] = normVal
        }
        for (const key of removedRootKeys) {
            for (const p of compare({ [key]: lastRoot[key] }, {})) patch.push(p)
            delete this.hashBlocks[key]
            this.lastRootKeyJsons.delete(key)
        }

        if (toSave.botPreset) {
            const normBotPresets = normalizeJSON(curBotPresets) ?? []
            const ops = diffArrayWithIdGuard(compare, '/botPresets', lastBotPresets, normBotPresets, 'id')
            for (const op of ops) patch.push(op)
            this.hashBlocks['botPresets'] = calculateHash(normBotPresets);
            this.lastSyncedDb.botPresets = normBotPresets;
        }

        if (toSave.modules) {
            // Checked per module, mirroring diffArrayWithIdGuard: editing one module's lorebook
            // changes the modules block on every save, and only that module should be re-diffed.
            const lastModulesArr: any[] = Array.isArray(lastModules) ? lastModules : []
            const curModulesArr: any[] = Array.isArray(curModules) ? curModules : []
            let structural = lastModulesArr.length !== curModulesArr.length
            if (!structural) {
                const lastModIds = lastModulesArr.map((m: any) => m?.id)
                const curModIds = curModulesArr.map((m: any) => m?.id)
                // Non-string ids (numbers, objects) go structural too: ids come
                // from importable data, and only strings are safe/strict as
                // cache keys (1 vs "1" must not collide).
                const hasInvalidIds = curModIds.some(id => !id || typeof id !== 'string') || lastModIds.some(id => !id || typeof id !== 'string')
                const hasDuplicates = new Set(curModIds).size !== curModIds.length
                structural = hasInvalidIds || hasDuplicates || lastModIds.some((id, i) => id !== curModIds[i])
            }

            if (structural) {
                const normModules = normalizeJSON(curModulesArr) ?? []
                patch.push({ op: 'replace', path: '/modules', value: normModules })
                this.hashBlocks['modules'] = calculateHash(normModules);
                this.lastSyncedDb.modules = normModules;
                this.lastModuleJsons = new Map();
                this.moduleItemHashes = new Map();
                for (const m of normModules) {
                    if (typeof m?.id === 'string' && m.id) {
                        this.lastModuleJsons.set(m.id, JSON.stringify(m))
                        this.moduleItemHashes.set(m.id, calculateHash(m))
                    }
                }
            } else {
                for (let i = 0; i < curModulesArr.length; i++) {
                    const id = curModulesArr[i].id
                    let curModJson: string | null = null
                    try { curModJson = JSON.stringify(curModulesArr[i]) } catch { curModJson = null }
                    if (curModJson !== null && curModJson === this.lastModuleJsons.get(id) && this.moduleItemHashes.has(id)) {
                        continue
                    }
                    const normModule = normalizeJSON(curModulesArr[i])
                    for (const p of compare(lastModulesArr[i], normModule)) {
                        patch.push({ ...p, path: `/modules/${i}${p.path}` })
                    }
                    this.moduleItemHashes.set(id, calculateHash(normModule))
                    this.lastModuleJsons.set(id, JSON.stringify(normModule))
                    this.lastSyncedDb.modules[i] = normModule
                }
                // Folded from the cached item hashes the way calculateHash folds an array, so it
                // stays identical to calculateHash(normalizeJSON(modules)).
                let modulesHash = SEED_ARRAY
                for (const m of (Array.isArray(this.lastSyncedDb.modules) ? this.lastSyncedDb.modules : [])) {
                    const cached = (typeof m?.id === 'string') ? this.moduleItemHashes.get(m.id) : undefined
                    const itemHash = cached !== undefined ? cached : calculateHash(m)
                    modulesHash = (Math.imul(modulesHash, PRIME_MULTIPLIER) + itemHash) >>> 0
                }
                this.hashBlocks['modules'] = modulesHash
            }
        }

        const lastIds = lastCharacters.map((c: any) => c?.chaId)
        const curIds = curCharacters.map((c: any) => c?.chaId)
        const structuralChange = lastIds.length !== curIds.length ||
            lastIds.some((id: string, i: number) => id !== curIds[i])

        // Replace chats with stubs for patch diff — full chat data lives server-side
        function withStubs(char: any, baseline?: any) {
            if (!char) return char
            return {
                ...characterWithServerBaseline(char, baseline),
                chats: (char.chats || []).map((c: any) => chatToStub(c)),
            }
        }

        if (structuralChange) {
            const lastById = new Map(lastCharacters.map((character: any) =>
                [character?.chaId, character]))
            const normChars = normalizeJSON(curCharacters.map((character: any) =>
                withStubs(character, lastById.get(character?.chaId))))
            patch.push({ op: 'replace', path: '/characters', value: normChars })
            for (const lastId of lastIds) {
                if (lastId) delete this.hashBlocks[lastId];
            }
            for (const char of normChars) {
                if (char?.chaId) {
                    this.hashBlocks[char.chaId] = calculateHash(char);
                }
            }
            this.lastSyncedDb.characters = normChars;
            // Normalized baselines, for the reason in init().
            this.lastCharJsons = new Map();
            for (const char of normChars) {
                if (char?.chaId) this.lastCharJsons.set(char.chaId, JSON.stringify(char))
            }
        } else {
            for (let i = 0; i < curCharacters.length; i++) {
                const lastChar = lastCharacters[i]
                const curChar = curCharacters[i]
                const curCharId = curChar?.chaId
                const trackedBySave = toSave.character.includes(curCharId ?? '')

                let curJson: string | null = null
                try { curJson = JSON.stringify(withStubs(curChar, lastChar)) } catch { curJson = null }
                if (!trackedBySave && curCharId && curJson !== null && curJson === this.lastCharJsons.get(curCharId)) {
                    continue
                }

                const normChar = normalizeJSON(withStubs(curChar, lastChar))
                const curCharHash = curCharId ? calculateHash(normChar) : undefined
                const changedByHash = !!(curCharId && curCharHash !== this.hashBlocks[curCharId])

                if (trackedBySave || changedByHash) {
                    let charPatch = compare(lastChar, normChar).map((v) => {
                        v.path = `/characters/${i}` + v.path;
                        return v;
                    })
                    patch.push(...charPatch);
                    this.hashBlocks[normChar.chaId] = curCharHash ?? calculateHash(normChar);
                    this.lastSyncedDb.characters[i] = normChar;
                }
                // Normalized, for the reason in init(); normChar is cycle-free, so stringify can't throw.
                if (curCharId) {
                    this.lastCharJsons.set(curCharId, JSON.stringify(normChar))
                }
            }
        }

        this.lastSyncedDb = {
            characters: this.lastSyncedDb.characters,
            botPresets: this.lastSyncedDb.botPresets,
            modules: this.lastSyncedDb.modules,
            ...nextRoot
        }

        return { patch }
    }
}
