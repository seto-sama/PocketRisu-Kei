import { toGetter } from "../globalApi.svelte";
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

export const SafeIdbFactory = {
    databases: async (): Promise<{ name: string; version: number }[]> => {
        if ('databases' in indexedDB) {
            const r = await indexedDB.databases();
            return r.filter(db => db.name && db.name.startsWith('safe_plugin_')).map(db => ({
                name: db.name!.substring('safe_plugin_'.length),
                version: db.version
            }));
        } else {
            return [];
        }
    },
    deleteDatabase: async (name: string): Promise<IDBOpenDBRequest> => {
        return indexedDB.deleteDatabase(`safe_plugin_${name}`);
    },
    open: (name: string, version?: number): IDBOpenDBRequest => {
        return indexedDB.open(`safe_plugin_${name}`, version);
    },
    cmp: (first: string, second: string): number => {
        // The same prefix on both strings would not change their ordering.
        return indexedDB.cmp(first, second);
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

const restrictElement = <T extends Node>(element: T): T => {
    //since we already trimed out, just return the element
    return element;
}

const restrictNodeList = <T extends Element, Q extends NodeListOf<T>|HTMLCollectionOf<T> >(nodeList: Q): Q => {
    return nodeList;
}

export const SafeDocument = {
    body: document.body,
    characterSet: document.characterSet,
    doctype: document.doctype,
    documentElement: document.documentElement,
    documentURI: document.documentURI,
    location: document.location,
    readyState: document.readyState,
    title: document.title,
    head: document.head,
    createElement: (tagName: string): HTMLElement => {
        if (import.meta.env.DEV) {
            console.log('Creating element:', tagName);
        }
        tagName = tagName.toLowerCase().trim();
        if (!tagWhitelist.includes(tagName.toLowerCase())) {
            throw new Error(`Creation of <${tagName}> elements is not allowed in plugin context.`);
        }
        if(tagName.toLowerCase() === 'a'){
            console.error(`
                Creation of <a> elements is restricted. due to potential security risks. Creating a <div> instead.
                Use document.createAnchorElement(href: string) from the plugin API to create safe anchor elements.
            `);
            return restrictElement(document.createElement('div')) as HTMLElement;
        }
        return restrictElement(document.createElement(tagName));
    },
    createTextNode: (data: string): Text => {
        return restrictElement(document.createTextNode(data));
    },
    createElementNS: (namespaceURI: string, qualifiedName: string): Element => {
        if (import.meta.env.DEV) {
            console.log('Creating namespaced element:', qualifiedName);
        }
        qualifiedName = qualifiedName.toLowerCase().trim();
        if (!tagWhitelist.includes(qualifiedName.toLowerCase())) {
            throw new Error(`Creation of <${qualifiedName}> elements is not allowed in plugin context.`);
        }
        if(qualifiedName.toLowerCase() === 'a'){
            console.error(`
                Creation of <a> elements is restricted. due to potential security risks. Creating a <div> instead.
                Use document.createAnchorElement(href: string) from the plugin API to create safe anchor elements.
            `);
            return restrictElement(document.createElementNS(namespaceURI, 'div'));
        }
        return restrictElement(document.createElementNS(namespaceURI, qualifiedName));
    },
    createAnchorElement: (href: string): HTMLAnchorElement => {
        const anchor = document.createElement('a');

        try {
            const hrefURL = new URL(href, document.baseURI);
            if(hrefURL.protocol !== 'http:' && hrefURL.protocol !== 'https:'){
                throw new Error(`Only http and https links are allowed for anchor elements in plugin context.`);
            }
            new URL(href);
        } catch {
            throw new Error(`Invalid URL provided for anchor element in plugin context.`);
        }

        anchor.href = href;
        return toGetter(() => anchor, {
            restrictChildren: [
                'ownerDocument',
                'href',
                'download',
                'hash',
                'host',
                'hostname',
                'hreflang',
                'origin',
                'password',
                'pathname',
                'ping',
                'port',
                'protocol',
                'referrerPolicy',
                'rel',
                'relList',
                'search',
                'target',
                'text',
                'type',
                'username'
            ]
        }) as HTMLAnchorElement;
    },

    createRange: (): Range => {
        return (document.createRange());
    },
    createDocumentFragment: (): DocumentFragment => {
        return restrictElement(document.createDocumentFragment());
    },
    querySelector: (selectors: string): Element | null => {
        return restrictElement(document.querySelector(selectors));
    },
    querySelectorAll: (selectors: string): NodeListOf<Element> => {
        return restrictNodeList(document.querySelectorAll(selectors));
    },
    getElementById: (elementId: string): HTMLElement | null => {
        return restrictElement(document.getElementById(elementId));
    },
    getElementsByClassName: (classNames: string): HTMLCollectionOf<Element> => {
        return restrictNodeList(document.getElementsByClassName(classNames))
    },
    getElementsByTagName: (qualifiedName: string): HTMLCollectionOf<Element> => {
        return restrictNodeList(document.getElementsByTagName(qualifiedName));
    },
    getElementsByName: (elementName: string): NodeListOf<Element> => {
        return restrictNodeList(document.getElementsByName(elementName));
    },
    createComment: (data: string): Comment => {
        return restrictElement(document.createComment(data));
    },
    elementFromPoint: (x: number, y: number): Element | null => {
        return restrictElement(document.elementFromPoint(x, y));
    },
    elementsFromPoint: (x: number, y: number): Element[] => {
        return document.elementsFromPoint(x, y).map(el => restrictElement(el));
    },
    hasFocus: (): boolean => {
        return document.hasFocus();
    },
    addEventListener: (type: string, listener: EventListenerOrEventListenerObject, options?: boolean | AddEventListenerOptions): void => {
        const allowedEvents = ['click', 'keydown', 'keyup', 'input', 'change', 'submit', 'focus', 'blur', 'mouseover', 'mouseout', 'mousemove', 'mousedown', 'mouseup'];
        if(!allowedEvents.includes(type)) {
            console.warn(`Event type '${type}' is not allowed in plugin context.`);
            return;
        }
        document.addEventListener(type, listener, options);
    },
    removeEventListener: (type: string, listener: EventListenerOrEventListenerObject, options?: boolean | EventListenerOptions): void => {
        const allowedEvents = ['click', 'keydown', 'keyup', 'input', 'change', 'submit', 'focus', 'blur', 'mouseover', 'mouseout', 'mousemove', 'mousedown', 'mouseup'];
        if(!allowedEvents.includes(type)) {
            console.warn(`Event type '${type}' is not allowed in plugin context.`);
            return;
        }
        document.removeEventListener(type, listener, options);
    }
}
