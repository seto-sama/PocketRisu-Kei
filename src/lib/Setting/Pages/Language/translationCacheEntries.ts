import { listPersistentKeys, readPersistentJson } from "src/ts/storage/persistentKv";
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

export async function listLLMCacheEntries(arg?: { limit?: number }): Promise<{
    entries: LLMCacheEntry[],
    total: number,
}> {
    const targetCount = Math.max(1, arg?.limit ?? 20);
    const entries: LLMCacheEntry[] = [];
    const seen = new Set<string>();
    const loadedEntries = loadedLLMCacheEntries();

    for (const entry of loadedEntries) {
        addEntry(entries, seen, entry.key, entry.value);
        if (entries.length >= targetCount) {
            return { entries, total: loadedEntries.length };
        }
    }

    const storageKeys = await listPersistentKeys(llmTranslateCachePrefix);
    const total = Math.max(loadedEntries.length, storageKeys.length);
    for (const storageKey of storageKeys) {
        const payload = await readPersistentJson<LLMCacheEntry>(storageKey);
        if (!payload) continue;
        cacheLoadedLLMEntry(payload.key, payload.value);
        addEntry(entries, seen, payload.key, payload.value);
        if (entries.length >= targetCount) {
            return { entries, total };
        }
    }

    return { entries, total };
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

    let loadedSinceYield = 0;
    for (const storageKey of storageKeys) {
        if (arg?.signal?.aborted) return { entries, total };

        const payload = await readPersistentJson<LLMCacheEntry>(storageKey);
        if (payload) {
            cacheLoadedLLMEntry(payload.key, payload.value);
            addEntry(entries, seen, payload.key, payload.value);
        }

        loadedSinceYield++;
        if (loadedSinceYield >= batchSize) {
            loadedSinceYield = 0;
            total = Math.max(total, entries.length);
            arg?.onProgress?.({ entries: [...entries], total, done: false });
            await new Promise<void>((resolve) => setTimeout(resolve, 0));
        }
    }

    total = entries.length;
    arg?.onProgress?.({ entries: [...entries], total, done: true });
    return { entries, total };
}
