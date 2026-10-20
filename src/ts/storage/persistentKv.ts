import { Buffer } from 'buffer'
import { hasher } from "../parser/parser.svelte";
import { forageStorage } from "./autoStorage";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

let initPromise: Promise<void> | null = null;

async function ensureStorageReady() {
    if (!initPromise) {
        initPromise = forageStorage.Init();
    }
    await initPromise;
}

function encodeKeyComponent(value: string) {
    return Buffer.from(value, "utf-8")
        .toString("base64")
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=+$/g, "");
}

async function readPersistentBytes(storageKey: string): Promise<Uint8Array | null> {
    await ensureStorageReady();
    return await forageStorage.getItem(storageKey) ?? null;
}

async function writePersistentBytes(storageKey: string, value: Uint8Array): Promise<void> {
    await ensureStorageReady();
    await forageStorage.setItem(storageKey, value);
}

export async function readPersistentJson<T>(storageKey: string): Promise<T | null> {
    const data = await readPersistentBytes(storageKey);
    if (!data) {
        return null;
    }
    return JSON.parse(decoder.decode(data)) as T;
}

export async function readPersistentJsonBatch<T>(storageKeys: string[]): Promise<Map<string, T>> {
    await ensureStorageReady();
    if (storageKeys.length === 0) return new Map();

    const entries = await forageStorage.getItems(storageKeys);
    const values = new Map<string, T>();
    for (const entry of entries) {
        try {
            values.set(entry.key, JSON.parse(decoder.decode(entry.value)) as T);
        }
        catch {
            // Match readPersistentJson: a malformed cache entry is unusable.
        }
    }
    return values;
}

export async function writePersistentJson<T>(storageKey: string, value: T): Promise<void> {
    await writePersistentBytes(storageKey, encoder.encode(JSON.stringify(value)));
}

export async function removePersistentKey(storageKey: string): Promise<void> {
    await ensureStorageReady();
    await forageStorage.removeItem(storageKey);
}

export async function listPersistentKeys(
    prefix = "",
    options?: { order?: 'updated-desc'; limit?: number; offset?: number },
): Promise<string[]> {
    await ensureStorageReady();
    return await forageStorage.keys(prefix, options);
}

export async function listPersistentKeyPage(
    prefix = "",
    options?: { order?: 'updated-desc'; limit?: number; offset?: number },
): Promise<{ keys: string[]; total: number }> {
    await ensureStorageReady();
    return await forageStorage.keyPage(prefix, options);
}

export async function clearPersistentPrefix(prefix: string): Promise<void> {
    const keys = await listPersistentKeys(prefix);
    const results = await Promise.allSettled(keys.map((key) => removePersistentKey(key)));
    const failed = results.find(result => result.status === 'rejected');
    if (failed) throw failed.reason;
}

export async function makeHashedStorageKey(prefix: string, rawKey: string): Promise<string> {
    const hash = await hasher(encoder.encode(rawKey));
    return `${prefix}${hash}.json`;
}

export function makeEncodedStorageKey(prefix: string, rawKey: string): string {
    return `${prefix}${encodeKeyComponent(rawKey)}.json`;
}
