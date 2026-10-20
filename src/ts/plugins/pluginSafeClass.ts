import { clearPersistentPrefix, decodeStorageKeyComponent, listPersistentKeys, makeEncodedStorageKey, readPersistentBytes, removePersistentKey, writePersistentBytes } from "../storage/persistentKv";
import { recordOwner, removeOwner, clearOwners } from "./pluginStorageMeta";
import { decodeLocalPluginStorageValue, encodeLocalPluginStorageValue, LOCAL_PLUGIN_STORAGE_PREFIX } from '../../../shared/localPluginStorageValue.mjs';

// Cache encoded bytes so iframe buffer transfers never detach the stored value.
const pluginStorage = new Map<string, Uint8Array>();
const pendingStorageOperations = new Map<string, Promise<unknown>>();
let storageClear: Promise<unknown> = Promise.resolve();
let storageEnumeration: Promise<unknown> = Promise.resolve();

function queueStorageOperation<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const next = Promise.allSettled([pendingStorageOperations.get(key), storageClear, storageEnumeration]).then(operation);
    pendingStorageOperations.set(key, next);
    const cleanup = () => {
        if (pendingStorageOperations.get(key) === next) pendingStorageOperations.delete(key);
    };
    void next.then(cleanup, cleanup);
    return next;
}

export class SafeLocalStorage {
    getItem(key: string): string | null {
        return localStorage.getItem(`safe_plugin_${key}`);
    }
    setItem(key: string, value: string): void {
        localStorage.setItem(`safe_plugin_${key}`, value);
    }
    removeItem(key: string): void {
        localStorage.removeItem(`safe_plugin_${key}`);
    }
    keys(): string[] {
        const keys: string[] = [];
        for (let i = 0; i < localStorage.length; i++) {
            const key = localStorage.key(i);
            if (key && key.startsWith('safe_plugin_')) {
                keys.push(key.substring('safe_plugin_'.length));
            }
        }
        return keys;
    }

    key(index: number): string | null {
        const safeKeys = this.keys();
        return safeKeys[index] ?? null;
    }

    clear(): void {
        const keys = this.keys();
        for (const key of keys) {
            this.removeItem(key);
        }
    }

    get length(): number {
        return this.keys().length;
    }
}

export class SafeLocalPluginStorage {
    __classType = 'REMOTE_REQUIRED' as const;
    constructor(private owner?: string) {}
    async getItem<T>(key: string): Promise<T | null> {
        return queueStorageOperation(key, async () => {
            const data = pluginStorage.get(key) ?? await readPersistentBytes(makeEncodedStorageKey(LOCAL_PLUGIN_STORAGE_PREFIX, key));
            if (!data) return null;
            const value = decodeLocalPluginStorageValue(data) as T;
            pluginStorage.set(key, data);
            return value;
        });
    }
    async setItem<T>(key: string, value: T): Promise<void> {
        // Snapshot before an earlier write or clear can delay this operation.
        const encoded = encodeLocalPluginStorageValue(value).then(
            data => ({ data }), error => ({ error }),
        );
        return queueStorageOperation(key, async () => {
            const result = await encoded;
            if ('error' in result) throw result.error;
            await writePersistentBytes(makeEncodedStorageKey(LOCAL_PLUGIN_STORAGE_PREFIX, key), result.data);
            pluginStorage.set(key, result.data);
            if (this.owner) await recordOwner('idb', key, this.owner);
        });
    }
    async removeItem(key: string): Promise<void> {
        return queueStorageOperation(key, async () => {
            await removePersistentKey(makeEncodedStorageKey(LOCAL_PLUGIN_STORAGE_PREFIX, key));
            pluginStorage.delete(key);
            if (this.owner) await removeOwner('idb', key);
        });
    }
    async keys(): Promise<string[]> {
        const pending = [...pendingStorageOperations.values(), storageClear, storageEnumeration];
        const enumeration = Promise.allSettled(pending).then(async () => {
            const storageKeys = await listPersistentKeys(LOCAL_PLUGIN_STORAGE_PREFIX);
            return storageKeys.map(key => decodeStorageKeyComponent(key.slice(LOCAL_PLUGIN_STORAGE_PREFIX.length, -'.json'.length)));
        });
        storageEnumeration = enumeration;
        return enumeration;
    }
    async clear(): Promise<void> {
        const pending = [...pendingStorageOperations.values(), storageClear, storageEnumeration];
        storageClear = Promise.allSettled(pending).then(async () => {
            pluginStorage.clear();
            await clearPersistentPrefix(LOCAL_PLUGIN_STORAGE_PREFIX);
            if (this.owner) await clearOwners('idb');
        });
        await storageClear;
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
