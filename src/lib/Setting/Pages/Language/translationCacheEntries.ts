import { listPersistentKeyPage, listPersistentKeys, readPersistentJsonBatch } from "src/ts/storage/persistentKv";
import {
    cacheLoadedLLMEntry,
    llmTranslateCachePrefix,
    loadedLLMCacheEntries,
    type LLMCacheEntry,
} from "src/ts/translator/translator";

function addEntry(entries: LLMCacheEntry[], seen: Set<string>, key: string, value: string) {
    if (seen.has(key)) return;
    seen.add(key);
    entries.push({ key, value });
}

export async function listLLMCacheEntries(arg?: { limit?: number, offset?: number }): Promise<{
    entries: LLMCacheEntry[],
    total: number,
    hasMore: boolean,
    nextOffset: number,
}> {
    const targetCount = Math.max(1, arg?.limit ?? 20);
    const offset = Math.max(0, arg?.offset ?? 0);
    const entries: LLMCacheEntry[] = [];
    const seen = new Set<string>();
    const page = await listPersistentKeyPage(llmTranslateCachePrefix, {
        order: 'updated-desc',
        limit: targetCount,
        offset,
    });
    const pageKeys = page.keys;
    const payloads = await readPersistentJsonBatch<LLMCacheEntry>(pageKeys);
    for (const storageKey of pageKeys) {
        const payload = payloads.get(storageKey);
        if (!payload) continue;
        cacheLoadedLLMEntry(payload.key, payload.value);
        addEntry(entries, seen, payload.key, payload.value);
    }

    return {
        entries,
        total: page.total,
        hasMore: offset + pageKeys.length < page.total,
        nextOffset: offset + pageKeys.length,
    };
}

export async function loadLLMCacheEntriesInBackground(arg?: {
    batchSize?: number,
    signal?: AbortSignal,
    onProgress?: (state: { entries: LLMCacheEntry[], total: number, done: boolean }) => void,
}): Promise<{ entries: LLMCacheEntry[], total: number }> {
    const batchSize = Math.max(1, arg?.batchSize ?? 200);
    const entries: LLMCacheEntry[] = [];
    const seen = new Set<string>();

    for (const entry of loadedLLMCacheEntries()) {
        if (arg?.signal?.aborted) return { entries, total: seen.size };
        addEntry(entries, seen, entry.key, entry.value);
    }

    const storageKeys = await listPersistentKeys(llmTranslateCachePrefix);
    let total = Math.max(entries.length, storageKeys.length);
    arg?.onProgress?.({ entries: [...entries], total, done: false });

    for (let offset = 0; offset < storageKeys.length; offset += batchSize) {
        if (arg?.signal?.aborted) return { entries, total };
        const batchKeys = storageKeys.slice(offset, offset + batchSize);
        const payloads = await readPersistentJsonBatch<LLMCacheEntry>(batchKeys);
        if (arg?.signal?.aborted) return { entries, total };

        for (const storageKey of batchKeys) {
            const payload = payloads.get(storageKey);
            if (!payload || seen.has(payload.key)) continue;
            cacheLoadedLLMEntry(payload.key, payload.value);
            addEntry(entries, seen, payload.key, payload.value);
        }
        total = Math.max(total, entries.length);
        arg?.onProgress?.({ entries: [...entries], total, done: false });
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }

    total = entries.length;
    arg?.onProgress?.({ entries: [...entries], total, done: true });
    return { entries, total };
}
