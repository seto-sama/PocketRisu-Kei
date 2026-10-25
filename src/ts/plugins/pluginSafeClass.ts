import { decode, encode } from 'msgpackr/index-no-eval';
import { forageStorage } from '../storage/autoStorage';
import type { PluginStorageNamespace, PluginStorageRequest, PluginStorageResponse } from '../storage/nodeStorage';
import { decodeLocalPluginStorageValue, encodeLocalPluginStorageValue } from '../../../shared/localPluginStorageValue.mjs';

const pendingStorageOperations = new Map<PluginStorageNamespace, Promise<unknown>>();
let migrationPending: Promise<void> | null = null;

function queueStorageOperation<T>(namespace: PluginStorageNamespace, operation: () => Promise<T>): Promise<T> {
    const previous = pendingStorageOperations.get(namespace) ?? Promise.resolve();
    const next = previous.then(operation, operation);
    pendingStorageOperations.set(namespace, next);
    const cleanup = () => {
        if (pendingStorageOperations.get(namespace) === next) pendingStorageOperations.delete(namespace);
    };
    void next.then(cleanup, cleanup);
    return next;
}

async function request(namespace: PluginStorageNamespace, body: PluginStorageRequest): Promise<PluginStorageResponse> {
    await ensurePluginStorageMigration();
    return forageStorage.pluginStorageRequest(namespace, body);
}

function requireValueResponse(response: PluginStorageResponse): Uint8Array | null {
    if (!('value' in response)) throw new Error('Invalid plugin storage value response');
    return response.value;
}

function requireSuccessResponse(response: PluginStorageResponse): void {
    if (!('success' in response) || response.success !== true) throw new Error('Invalid plugin storage mutation response');
}

function requireEntriesResponse(response: PluginStorageResponse): Array<{ key: string, owner?: string }> {
    if (!('entries' in response)) throw new Error('Invalid plugin storage list response');
    return response.entries;
}

function listNamespaceKeys(namespace: PluginStorageNamespace): Promise<string[]> {
    return queueStorageOperation(namespace, async () => (
        requireEntriesResponse(await request(namespace, { op: 'list' })).map(entry => entry.key)
    ));
}

function clearNamespace(namespace: PluginStorageNamespace): Promise<void> {
    return queueStorageOperation(namespace, async () => {
        requireSuccessResponse(await request(namespace, { op: 'clear' }));
    });
}

/** Import the old browser-local keys once; server import leaves existing values untouched. */
export function ensurePluginStorageMigration(): Promise<void> {
    if (migrationPending) return migrationPending;
    const migration = (async () => {
        const prefix = 'safe_plugin_';
        const legacyOwnerKey = 'risu_plugin_storage_owners';
        const ownerSnapshot = localStorage.getItem(legacyOwnerKey);
        let owners: Record<string, { plugin?: unknown }> = {};
        try {
            const parsed = JSON.parse(ownerSnapshot || '{}');
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) owners = parsed;
        } catch {}

        const legacy: Array<{ storageKey: string, value: string, owner?: string }> = [];
        for (let i = 0; i < localStorage.length; i++) {
            const storageKey = localStorage.key(i);
            if (!storageKey?.startsWith(prefix)) continue;
            const value = localStorage.getItem(storageKey);
            if (value === null) continue;
            const key = storageKey.slice(prefix.length);
            const plugin = owners[key]?.plugin;
            legacy.push({ storageKey, value, owner: typeof plugin === 'string' && plugin ? plugin : undefined });
        }

        if (legacy.length) {
            const response = await forageStorage.pluginStorageRequest('localStorage', {
                op: 'import',
                entries: legacy.map(({ storageKey, value, owner }) => ({
                    key: storageKey.slice(prefix.length),
                    value: encode(value),
                    ...(owner ? { owner } : {}),
                })),
            });
            requireSuccessResponse(response);
        }

        for (const entry of legacy) {
            if (localStorage.getItem(entry.storageKey) === entry.value) localStorage.removeItem(entry.storageKey);
        }
        if (ownerSnapshot !== null && localStorage.getItem(legacyOwnerKey) === ownerSnapshot) {
            localStorage.removeItem(legacyOwnerKey);
        }
    })();
    migrationPending = migration;
    void migration.catch(() => {
        if (migrationPending === migration) migrationPending = null;
    });
    return migration;
}

export class SafeLocalStorage {
    constructor(private owner?: string) {}

    async getItem(key: string): Promise<string | null> {
        const storageKey = String(key);
        return queueStorageOperation('localStorage', async () => {
            const data = requireValueResponse(await request('localStorage', { op: 'get', key: storageKey }));
            return data === null ? null : decode(data) as string;
        });
    }

    async setItem(key: string, value: string): Promise<void> {
        const storageKey = String(key);
        const snapshot = encode(String(value));
        return queueStorageOperation('localStorage', async () => {
            requireSuccessResponse(await request('localStorage', {
                op: 'set', key: storageKey, value: snapshot, ...(this.owner ? { owner: this.owner } : {}),
            }));
        });
    }

    async removeItem(key: string): Promise<void> {
        const storageKey = String(key);
        return queueStorageOperation('localStorage', async () => {
            requireSuccessResponse(await request('localStorage', { op: 'remove', key: storageKey }));
        });
    }

    async keys(): Promise<string[]> {
        return listNamespaceKeys('localStorage');
    }

    async key(index: number): Promise<string | null> {
        const safeKeys = await this.keys();
        return safeKeys[index] ?? null;
    }

    async clear(): Promise<void> {
        await clearNamespace('localStorage');
    }

    get length(): Promise<number> {
        return this.keys().then(keys => keys.length);
    }
}

export class SafeLocalPluginStorage {
    __classType = 'REMOTE_REQUIRED' as const;
    constructor(private owner?: string) {}

    async getItem<T>(key: string): Promise<T | null> {
        return queueStorageOperation('localForage', async () => {
            const data = requireValueResponse(await request('localForage', { op: 'get', key }));
            if (!data) return null;
            return decodeLocalPluginStorageValue(data) as T;
        });
    }

    async setItem<T>(key: string, value: T): Promise<void> {
        const snapshot = encodeLocalPluginStorageValue(value).then(
            data => ({ data }), error => ({ error }),
        );
        return queueStorageOperation('localForage', async () => {
            const result = await snapshot;
            if ('error' in result) throw result.error;
            requireSuccessResponse(await request('localForage', {
                op: 'set', key, value: result.data, ...(this.owner ? { owner: this.owner } : {}),
            }));
        });
    }

    async removeItem(key: string): Promise<void> {
        return queueStorageOperation('localForage', async () => {
            requireSuccessResponse(await request('localForage', { op: 'remove', key }));
        });
    }

    async keys(): Promise<string[]> {
        return listNamespaceKeys('localForage');
    }

    async clear(): Promise<void> {
        await clearNamespace('localForage');
    }
}

export const tagWhitelist = [
    'a',
    'abbr',
    'acronym',
    'address',
    'area',
    'article',
    'aside',
    'audio',
    'b',
    'bdi',
    'bdo',
    'big',
    'blink',
    'blockquote',
    'body',
    'br',
    'button',
    'canvas',
    'caption',
    'center',
    'cite',
    'code',
    'col',
    'colgroup',
    'content',
    'data',
    'datalist',
    'dd',
    'decorator',
    'del',
    'details',
    'dfn',
    'dialog',
    'dir',
    'div',
    'dl',
    'dt',
    'element',
    'em',
    'fieldset',
    'figcaption',
    'figure',
    'font',
    'footer',
    'form',
    'h1',
    'h2',
    'h3',
    'h4',
    'h5',
    'h6',
    'head',
    'header',
    'hgroup',
    'hr',
    'html',
    'i',
    'img',
    'input',
    'ins',
    'kbd',
    'label',
    'legend',
    'li',
    'main',
    'map',
    'mark',
    'marquee',
    'menu',
    'menuitem',
    'meter',
    'nav',
    'nobr',
    'ol',
    'optgroup',
    'option',
    'output',
    'p',
    'picture',
    'pre',
    'progress',
    'q',
    'rp',
    'rt',
    'ruby',
    's',
    'samp',
    'search',
    'section',
    'select',
    'shadow',
    'slot',
    'small',
    'source',
    'spacer',
    'span',
    'strike',
    'strong',
    'style',
    'sub',
    'summary',
    'sup',
    'table',
    'tbody',
    'td',
    'template',
    'textarea',
    'tfoot',
    'th',
    'thead',
    'time',
    'tr',
    'track',
    'tt',
    'u',
    'ul',
    'var',
    'video',
    'wbr',
    'svg',
    'a',
    'altglyph',
    'altglyphdef',
    'altglyphitem',
    'animatecolor',
    'animatemotion',
    'animatetransform',
    'circle',
    'clippath',
    'defs',
    'desc',
    'ellipse',
    'enterkeyhint',
    'exportparts',
    'filter',
    'font',
    'g',
    'glyph',
    'glyphref',
    'hkern',
    'image',
    'inputmode',
    'line',
    'lineargradient',
    'marker',
    'mask',
    'metadata',
    'mpath',
    'part',
    'path',
    'pattern',
    'polygon',
    'polyline',
    'radialgradient',
    'rect',
    'stop',
    'style',
    'switch',
    'symbol',
    'text',
    'textpath',
    'title',
    'tref',
    'tspan',
    'view',
    'vkern',
];
