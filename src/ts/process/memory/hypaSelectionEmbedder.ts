import type { HypaSelectionEmbedder } from "../../../../shared/hypaSelection.mjs";
import { getDatabase } from "src/ts/storage/database.svelte";
import { getContextProvider } from "./contextualEmbedding";
import {
    DEFAULT_HYPA_MODEL,
    HypaProcesser,
    chunkEmbeddingInputs,
    getPersistedHypaVectors,
    hypaVectorCache,
    setPersistedHypaVector,
    type VectorArray,
} from "./hypamemory";
import { TaskConcurrencyLimiter, TaskCanceledError } from "./taskConcurrencyLimiter";

type HypaChunk = Parameters<HypaSelectionEmbedder["documents"]>[0][number];

async function readCachedVectors(keys: string[]): Promise<(VectorArray | undefined)[]> {
    const cached = await getPersistedHypaVectors(keys)
        .catch(() => keys.map(key => hypaVectorCache.get(key)));
    return cached.map(vector => vector?.embedding);
}

/**
 * Browser embedder for the shared HypaV3 selection. Results stay positional,
 * so identical chunk texts keep their own vectors; document vectors are
 * persisted per model (and per summary context for contextual models).
 */
export function createClientHypaEmbedder(limiter: TaskConcurrencyLimiter): HypaSelectionEmbedder {
    const db = getDatabase();
    const model = db.hypaModel || DEFAULT_HYPA_MODEL;
    const processor = new HypaProcesser(model);
    const contextual = getContextProvider(model);
    const customModel = model === "custom" ? db.hypaCustomSettings?.model?.trim() : "";
    const standardKey = (content: string) => `${content}|${model}${customModel ? `-${customModel}` : ""}`;

    async function embedBatches(inputs: string[], inputType: "query" | "document"): Promise<VectorArray[]> {
        const batchResult = await limiter.executeBatch(
            chunkEmbeddingInputs(inputs).map(batch => () => processor.getEmbeds(batch, inputType))
        );
        const failures = batchResult.results.filter(result => !result.success);
        if (failures.length > 0) {
            throw (failures.find(result => !(result.error instanceof TaskCanceledError)) ?? failures[0]).error;
        }
        return batchResult.results.flatMap(result => result.data);
    }

    async function standardDocuments(chunks: HypaChunk[]): Promise<VectorArray[]> {
        const contents = [...new Set(chunks.map(chunk => chunk.content))];
        const keys = contents.map(standardKey);
        const vectors = new Map<string, VectorArray>();
        const cached = await readCachedVectors(keys);
        const missing = contents.filter((content, index) => {
            if (!cached[index]) return true;
            vectors.set(content, cached[index]);
            return false;
        });
        if (missing.length > 0) {
            const embeddings = await embedBatches(missing, "document");
            for (let index = 0; index < missing.length; index++) {
                vectors.set(missing[index], embeddings[index]);
                await setPersistedHypaVector(standardKey(missing[index]), {
                    content: missing[index],
                    embedding: embeddings[index],
                });
            }
        }
        return chunks.map(chunk => vectors.get(chunk.content));
    }

    async function contextualDocuments(chunks: HypaChunk[]): Promise<VectorArray[]> {
        const groups = new Map<number, number[]>();
        chunks.forEach((chunk, index) => {
            const group = groups.get(chunk.summaryIndex) ?? [];
            group.push(index);
            groups.set(chunk.summaryIndex, group);
        });
        const groupList = [...groups.values()].map(indexes => {
            const texts = indexes.map(index => chunks[index].content);
            const suffix = contextual.getCacheKeySuffix(texts);
            // Repeated texts inside one summary get distinct contextual vectors,
            // so only those groups need position-qualified keys.
            const positional = new Set(texts).size !== texts.length;
            return {
                indexes,
                texts,
                keys: texts.map((text, position) => `${text}${suffix}${positional ? `|chunk:${position}` : ""}`),
            };
        });
        const vectors: VectorArray[] = new Array(chunks.length);
        const cached = await readCachedVectors(groupList.flatMap(group => group.keys));
        let offset = 0;
        const toEmbed = groupList.filter(group => {
            const groupCached = cached.slice(offset, offset + group.keys.length);
            offset += group.keys.length;
            if (groupCached.some(vector => !vector)) return true;
            group.indexes.forEach((chunkIndex, position) => {
                vectors[chunkIndex] = groupCached[position];
            });
            return false;
        });
        if (toEmbed.length > 0) {
            const embedded = await contextual.embedDocumentGroups(toEmbed.map(group => group.texts));
            for (let groupIndex = 0; groupIndex < toEmbed.length; groupIndex++) {
                const group = toEmbed[groupIndex];
                for (let position = 0; position < group.indexes.length; position++) {
                    const embedding = embedded[groupIndex]?.[position];
                    if (!embedding) {
                        throw new Error(`Failed to create vector for summary chunk:\n${group.texts[position]}`);
                    }
                    vectors[group.indexes[position]] = embedding;
                    await setPersistedHypaVector(group.keys[position], {
                        content: group.texts[position],
                        embedding,
                    });
                }
            }
        }
        return vectors;
    }

    // The shared selector requests documents and queries together; run them
    // one after another so embeddingMaxConcurrent bounds the whole selection.
    let pending: Promise<unknown> = Promise.resolve();
    const serialized = <T>(task: () => Promise<T>): Promise<T> => {
        const result = pending.then(task, task);
        pending = result.catch(() => undefined);
        return result;
    };

    return {
        documents: chunks => serialized(() => contextual ? contextualDocuments(chunks) : standardDocuments(chunks)),
        queries: contents => serialized(() => embedBatches(contents, "query")),
    };
}
