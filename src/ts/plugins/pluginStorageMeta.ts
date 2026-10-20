// Keep ownership metadata in the value's backend so backups and deletion share its lifecycle.

import { getDatabase } from "../storage/database.svelte";
import {
    listPersistentKeys,
    makeEncodedStorageKey,
    decodeStorageKeyComponent,
    readPersistentJsonBatch,
    writePersistentJson,
    removePersistentKey,
    clearPersistentPrefix,
} from "../storage/persistentKv";

export type PluginStorageBackend = "save" | "local" | "idb";
interface PluginOwnerRecord {
    plugin: string;
    updatedAt: number;
}

const LOCAL_META_KEY = "risu_plugin_storage_owners";
const IDB_META_PREFIX = "cache/plugin-storage-meta/";

function readLocalMeta(): Record<string, PluginOwnerRecord> {
    try {
        return JSON.parse(localStorage.getItem(LOCAL_META_KEY) || "{}");
    } catch {
        return {};
    }
}

function writeLocalMeta(map: Record<string, PluginOwnerRecord>): void {
    try {
        localStorage.setItem(LOCAL_META_KEY, JSON.stringify(map));
    } catch {}
}

export function recordOwner(backend: PluginStorageBackend, key: string, plugin: string): void | Promise<void> {
    if (!plugin) return;
    const record: PluginOwnerRecord = { plugin, updatedAt: Date.now() };
    if (backend === "save") {
        const db = getDatabase();
        db.pluginStorageMeta ??= {};
        db.pluginStorageMeta[key] = record;
        return;
    }
    if (backend === "local") {
        const map = readLocalMeta();
        map[key] = record;
        writeLocalMeta(map);
        return;
    }
    return writePersistentJson(makeEncodedStorageKey(IDB_META_PREFIX, key), record);
}

export function removeOwner(backend: PluginStorageBackend, key: string): void | Promise<void> {
    if (backend === "save") {
        const db = getDatabase();
        if (db.pluginStorageMeta) delete db.pluginStorageMeta[key];
        return;
    }
    if (backend === "local") {
        const map = readLocalMeta();
        delete map[key];
        writeLocalMeta(map);
        return;
    }
    return removePersistentKey(makeEncodedStorageKey(IDB_META_PREFIX, key));
}

export function clearOwners(backend: PluginStorageBackend): void | Promise<void> {
    if (backend === "save") {
        const db = getDatabase();
        db.pluginStorageMeta = {};
        return;
    }
    if (backend === "local") {
        writeLocalMeta({});
        return;
    }
    return clearPersistentPrefix(IDB_META_PREFIX);
}

export async function getOwners(backend: PluginStorageBackend): Promise<Record<string, string>> {
    let records: [string, PluginOwnerRecord][];
    if (backend === "save") {
        records = Object.entries(getDatabase().pluginStorageMeta ?? {});
    } else if (backend === "local") {
        records = Object.entries(readLocalMeta());
    } else {
        const keys = await listPersistentKeys(IDB_META_PREFIX);
        const stored = await readPersistentJsonBatch<PluginOwnerRecord>(keys);
        records = [...stored].map(([fullKey, record]) => [
            decodeStorageKeyComponent(fullKey.slice(IDB_META_PREFIX.length, -".json".length)), record,
        ]);
    }
    return Object.fromEntries(records.filter(([, record]) => record?.plugin).map(([key, record]) => [key, record.plugin]));
}
