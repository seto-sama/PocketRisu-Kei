import { globalFetch } from "src/ts/globalApi.svelte";
import { appendLastPath } from "src/ts/util";
import { getDatabase } from "src/ts/storage/database.svelte";
import { makeHashedStorageKey, readPersistentJsonBatch, writePersistentJson } from "src/ts/storage/persistentKv";
import { isContextModel, getContextProvider } from "./contextualEmbedding";
import { isLocalNetworkUrl } from "src/ts/network/localNetwork";
import { TaskConcurrencyLimiter } from "./taskConcurrencyLimiter";

import { DEFAULT_HYPA_MODEL, HYPA_EMBEDDING_BATCH_SIZE, type HypaModel } from './embeddingModels';
export { DEFAULT_HYPA_MODEL, type HypaModel } from './embeddingModels';

export const hypaVectorCache = new Map<string, memoryVector>();
export const hypaVectorCachePrefix = 'cache/hypa-vector/';
const MAX_CACHED_VECTORS = 512;

function rememberVector(key: string, value: memoryVector): void {
    hypaVectorCache.delete(key);
    hypaVectorCache.set(key, value);
    while (hypaVectorCache.size > MAX_CACHED_VECTORS) {
        hypaVectorCache.delete(hypaVectorCache.keys().next().value);
    }
}

const MAX_ERROR_BODY_LENGTH = 300

/** Keeps embedding service error bodies useful without flooding the chat UI. */
export function truncateErrorBody(data: unknown): string {
    let text: string
    try {
        text = typeof data === 'string' ? data : JSON.stringify(data)
    } catch {
        text = String(data)
    }
    text = text ?? String(data)
    return text.length > MAX_ERROR_BODY_LENGTH
        ? `${text.slice(0, MAX_ERROR_BODY_LENGTH)}… (${text.length} chars)`
        : text
}

export async function getPersistedHypaVectors(cacheKeys: string[]): Promise<(memoryVector | undefined)[]> {
    const results = cacheKeys.map(key => {
        const value = hypaVectorCache.get(key)
        if (value !== undefined) rememberVector(key, value)
        return value
    })
    const missing = cacheKeys.flatMap((key, index) => results[index] === undefined ? [{ key, index }] : [])
    if (missing.length === 0) return results

    const storageKeys = await Promise.all(missing.map(({ key }) => makeHashedStorageKey(hypaVectorCachePrefix, key)))
    const payloads = await readPersistentJsonBatch<{ key: string, value: memoryVector }>([...new Set(storageKeys)])
    missing.forEach(({ key, index }, offset) => {
        const payload = payloads.get(storageKeys[offset])
        if (!payload || payload.key !== key) return
        rememberVector(key, payload.value)
        results[index] = payload.value
    })
    return results
}

export async function setPersistedHypaVector(cacheKey: string, value: memoryVector) {
    const normalizedValue: memoryVector = {
        ...value,
        embedding: Array.from(value.embedding)
    }
    rememberVector(cacheKey, normalizedValue)
    const storageKey = await makeHashedStorageKey(hypaVectorCachePrefix, cacheKey)
    await writePersistentJson(storageKey, {
        key: cacheKey,
        value: normalizedValue
    })
}

export class HypaProcesser{
    oaikey:string
    vectors:memoryVector[]
    model:HypaModel
    customEmbeddingUrl:string
    concurrencyLimiter?:TaskConcurrencyLimiter

    constructor(model:HypaModel|'auto' = 'auto',customEmbeddingUrl?:string){
        this.vectors = []
        const db = getDatabase()
        this.model = model === 'auto' ? db.hypaModel || DEFAULT_HYPA_MODEL : model
        this.customEmbeddingUrl = customEmbeddingUrl?.trim() || db.hypaCustomSettings?.url?.trim() || ""
    }

    async embedDocuments(texts: string[]): Promise<VectorArray[]> {
        const subPrompts = chunkEmbeddingInputs(texts);

        const embeddings: VectorArray[] = [];

        if (this.concurrencyLimiter) {
          const batchResult = await this.concurrencyLimiter.executeBatch(
            subPrompts.map(input => () => this.getEmbeds(input, 'document'))
          );
          const failed = batchResult.results.find(result => !result.success);
          if (failed) throw failed.error;
          for (const result of batchResult.results) embeddings.push(...result.data);
          return embeddings;
        }

        for (const input of subPrompts) {
          embeddings.push(...await this.getEmbeds(input, 'document'));
        }

        return embeddings;
    }

    async getEmbeds(input:string[]|string, inputType:'query'|'document' = 'query'):Promise<VectorArray[]> {
        if(isContextModel(this.model)){
            const provider = getContextProvider(this.model)
            const inputs:string[] = Array.isArray(input) ? input : [input]
            if(inputType === 'query'){
                return provider.embedQueries(inputs)
            }
            const groups = inputs.map(s => [s])
            const results = await provider.embedDocumentGroups(groups)
            return results.map(group => group[0])
        }
        let gf = null;
        if(this.model === 'custom'){
            if(!this.customEmbeddingUrl){
                throw new Error('Custom model requires a Custom Server URL')
            }
            const {customEmbeddingUrl} = this
            const replaceUrl = customEmbeddingUrl.endsWith('/embeddings')?customEmbeddingUrl:appendLastPath(customEmbeddingUrl,'embeddings')

            const db = getDatabase()
            const fetchArgs = {
                headers: {
                    ...(db.hypaCustomSettings?.key?.trim() ? {"Authorization": "Bearer " + db.hypaCustomSettings.key.trim()} : {})
                },
                body: {
                    "input": input,
                    ...(db.hypaCustomSettings?.model?.trim() ? {"model": db.hypaCustomSettings.model.trim()} : {})
                }
            };
 
            const localNetworkOpts = isLocalNetworkUrl(replaceUrl.toString()) ? { networkRoute: 'local_network' as const } : {};
            gf = await globalFetch(replaceUrl.toString(), { ...fetchArgs, ...localNetworkOpts })
        }
        else if(this.model === 'ada' || this.model === 'openai3small' || this.model === 'openai3large'){
            const db = getDatabase()
            const models = {
                'ada':'text-embedding-ada-002',
                'openai3small':'text-embedding-3-small',
                'openai3large':'text-embedding-3-large'
            }

            gf = await globalFetch("https://api.openai.com/v1/embeddings", {
                headers: {
                    "Authorization": "Bearer " + (this.oaikey?.trim() || db.supaMemoryKey?.trim())
                },
                body: {
                    "input": input,
                    "model": models[this.model]
                }
            })
        }
        else if(this.model === 'voyage4large'){
            const db = getDatabase()
            gf = await globalFetch('https://api.voyageai.com/v1/embeddings', {
                headers: { 'Authorization': 'Bearer ' + db.voyageApiKey.trim() },
                body: { input, model: 'voyage-4-large', input_type: inputType }
            })
        }
        else {
            throw new Error(`Unsupported model: ${this.model}`)
        }

        if(!gf.ok || !gf.data?.data){
            throw new Error(truncateErrorBody(gf.data))
        }

        return gf.data.data.map((item: { embedding: VectorArray }) => {
            if(!item.embedding){
                throw new Error('No embeddings found in the response.')
            }
            return item.embedding
        })
    }

    async addText(texts:string[]) {
        const db = getDatabase()
        const suffix = (this.model === 'custom' && db.hypaCustomSettings?.model?.trim()) ? `-${db.hypaCustomSettings.model.trim()}` : ""

        const existingContents = new Set(this.vectors.map(vector => vector.content))
        texts = [...new Set(texts)].filter(text => !existingContents.has(text))
        const cached = await getPersistedHypaVectors(texts.map(text => text + '|' + this.model + suffix))
        for(const itm of cached){
            if(itm){
                this.vectors.push(itm)
                existingContents.add(itm.content)
            }
        }

        texts = texts.filter(text => !existingContents.has(text))

        if(texts.length === 0){
            return
        }
        const vectors = await this.embedDocuments(texts)

        const memoryVectors:memoryVector[] = vectors.map((embedding, idx) => ({
            content: texts[idx],
            embedding
        }));

        for(let i=0;i<memoryVectors.length;i++){
            const vec = memoryVectors[i]
            await setPersistedHypaVector(texts[i] + '|' + this.model + suffix, vec)
        }

        this.vectors = memoryVectors.concat(this.vectors)
    }

    async similaritySearch(query: string) {
        const results = await this.similaritySearchScored(query);
        return results.map((result) => result[0]);
    }

    async similaritySearchScored(query: string): Promise<[string, number][]> {
        const embedding = (await this.getEmbeds(query))[0]
        return this.vectors
            .map((vector): [string, number] => [vector.content, similarity(embedding, vector.embedding)])
            .sort((a, b) => b[1] - a[1])
    }

}

export function similarity(a:VectorArray, b:VectorArray) {
    let dot = 0;
    for(let i=0;i<a.length;i++){
        dot += a[i] * b[i]
    }
    return dot
}

export function contextHash(texts: string[]): string {
    let h = 0x811c9dc5
    const s = texts.join('\0')
    for (let i = 0; i < s.length; i++) {
        h ^= s.charCodeAt(i)
        h = Math.imul(h, 0x01000193)
    }
    return (h >>> 0).toString(36)
}

export type VectorArray = number[]|Float32Array

export type memoryVector = {
    embedding:VectorArray,
    content:string
}

export function chunkEmbeddingInputs<T>(items: T[]): T[][] {
    const chunks: T[][] = []
    for (let i = 0; i < items.length; i += HYPA_EMBEDDING_BATCH_SIZE) {
        chunks.push(items.slice(i, i + HYPA_EMBEDDING_BATCH_SIZE))
    }
    return chunks
}
