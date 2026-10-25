import { getDatabase } from "../storage/database.svelte";
import { forageStorage } from "../storage/autoStorage";
import type { PluginStorageNamespace } from "../storage/nodeStorage";

export type PluginStorageBackend = "includedInSave" | PluginStorageNamespace;

export function recordOwner(key: string, plugin: string): void {
    if (!plugin) return;
    const db = getDatabase();
    db.pluginStorageMeta ??= {};
    db.pluginStorageMeta[key] = { plugin, updatedAt: Date.now() };
}

export function removeOwner(key: string): void {
    const db = getDatabase();
    if (db.pluginStorageMeta) delete db.pluginStorageMeta[key];
}

export function clearOwners(): void {
    getDatabase().pluginStorageMeta = {};
}

export async function getOwners(backend: PluginStorageBackend): Promise<Record<string, string>> {
    if (backend === "includedInSave") {
        const records = Object.entries(getDatabase().pluginStorageMeta ?? {});
        return Object.fromEntries(records.filter(([, record]) => record?.plugin).map(([key, record]) => [key, record.plugin]));
    }

    const response = await forageStorage.pluginStorageRequest(backend, { op: 'list' });
    if (!('entries' in response)) throw new Error('Invalid plugin storage list response');
    return Object.fromEntries(response.entries.filter(entry => entry.owner).map(entry => [entry.key, entry.owner!]));
}
