import { hasher } from "../parser/parser.svelte";
import { forageStorage } from "../globalApi.svelte";

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

function decodeKeyComponent(value: string) {
    const padded = value
        .replace(/-/g, "+")
        .replace(/_/g, "/")
        .padEnd(Math.ceil(value.length / 4) * 4, "=");
    return Buffer.from(padded, "base64").toString("utf-8");
}

export async function readPersistentJson<T>(storageKey: string): Promise<T | null> {
    await ensureStorageReady();
    const data = await forageStorage.getItem(storageKey);
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
    await ensureStorageReady();
    await forageStorage.setItem(storageKey, encoder.encode(JSON.stringify(value)));
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
    await Promise.all(keys.map((key) => removePersistentKey(key)));
}

export async function makeHashedStorageKey(prefix: string, rawKey: string): Promise<string> {
    const hash = await hasher(encoder.encode(rawKey));
    return `${prefix}${hash}.json`;
}

export function makeEncodedStorageKey(prefix: string, rawKey: string): string {
    return `${prefix}${encodeKeyComponent(rawKey)}.json`;
}

export function decodeStorageKeyComponent(encodedKey: string): string {
    return decodeKeyComponent(encodedKey);
}
