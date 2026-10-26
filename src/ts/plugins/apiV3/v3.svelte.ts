import { isDebugEnabled } from 'src/ts/debug'
import { handlePluginInstallViaPlugin, type RisuPlugin } from '../plugins.svelte'
import { allowedDbKeys, createPluginApis } from '../pluginApi.svelte'
import { pluginProviderRequestContextKey, pluginRuntime, type PluginProviderRequestContext, type PluginProviderArgument, type PluginProviderFunction } from '../pluginRuntime'
import { getRpcAbortSignalMetadata, SandboxHost, setRpcAbortSignalMetadata } from "./factory";
import { getDatabase } from "src/ts/storage/database.svelte";
import { getCurrentImageGenerationPreset } from "src/ts/imageGeneration/presets";
import { getChatPage, initializeChatSelection, withChatSelection } from 'src/ts/storage/chatSelection.svelte';
import { getChatFromIndex, setChatToIndex } from './chatAccess.svelte';
import { SafeLocalPluginStorage, tagWhitelist } from "../pluginSafeClass";
import { recordOwner, removeOwner, clearOwners } from "../pluginStorageMeta";
import DOMPurify from 'dompurify';
import { additionalChatMenu, additionalFloatingActionButtons, additionalHamburgerMenu, additionalSettingsMenu, bodyIntercepterStore, chatPanelStore, DBState, selectedCharID, type MenuDef } from "src/ts/stores.svelte";
import { automaticPluginSidebarMenuKey, pluginSidebarMenuKey, rememberPluginSidebarMenuItem, removeSidebarMenuKeys } from "src/ts/sidebarMenuOrder";
import { createEntityId, ensureUniqueEntityIds } from 'src/ts/id';
import { sleep } from "src/ts/util";
import { alertConfirm, alertError, alertNormal, alertNormalWait } from "src/ts/alert";
import { language } from "src/lang";
import { checkCharOrder, forageStorage, getFetchLogs } from "src/ts/globalApi.svelte";
import { changeColorScheme, normalizeColorScheme, updateColorScheme, updateTextThemeAndCSS, withLegacyColorSchemeAliases, type ColorScheme, type LegacyColorScheme } from "src/ts/gui/colorscheme";
import { layerZIndexes } from "src/ts/gui/layers";
import { get } from "svelte/store";
import { registerMCPModule, unregisterMCPModule } from "src/ts/process/mcp/pluginmcp";
import { getLLMCache, searchLLMCache } from "src/ts/translator/translator";
import { hasher, risuChatParser, type CbsConditions } from "src/ts/parser/parser.svelte";
import { LLMFlags, LLMFormat, LLMProvider, LLMTokenizer, type LLMModel } from "src/ts/model/types";
import { readPersistentJson, removePersistentKey, writePersistentJson } from "src/ts/storage/persistentKv";
import { sendChat as processSendChat, doingChat } from "src/ts/process/index.svelte";
import { processScriptFull } from "src/ts/process/scripts";
import type { ModelModeExtended } from "src/ts/process/request/shared";
import { requestChatDataMain } from "src/ts/process/request/request";
import { resolveChatModelBinding } from "src/ts/process/request/modelPresetBinding";
import type { OpenAIChat } from "src/ts/process/index.svelte";
import { getModuleLorebooks } from "src/ts/process/modules";
import {
    registerTTSPreprocessor,
    unregisterTTSPreprocessor,
    registerTTSPostprocessor,
    unregisterTTSPostprocessor,
    type BeforeTTSContext,
    type BeforeTTSResult,
    type AfterTTSContext,
    type AfterTTSResult,
    type TTSHookFn,
} from "src/ts/process/ttsHooks";
import { classifyPluginProviderFetch, type PluginProviderFetchOptions } from "./providerFetchClassification";
import type { AdapterResponseDecoder } from "src/ts/preset/adapter/types";
import { authorizePluginRequest } from './pluginNetworkPolicy';
import { resolveProviderRequestContext, withProviderRequestContext } from './providerRequestContext';
import type { FetchNativeArgs } from 'src/ts/network/nativeFetch';
import { readGlobalFetchResponse } from 'src/ts/network/fetchResult';
import { EPHEMERAL_SERVER_LLM_EXECUTION, type LLMExecutionPolicy } from 'src/ts/network/transportTypes';
import { getInlayAsset } from "src/ts/process/files/inlays";
import {
    PluginPermissionDialogQueue,
    type PluginPermissionDesc,
} from "./pluginPermissionState";

/*
 * Sandbox RPC exposes functions only. Build nested APIs with _getAliases and
 * constants with _getPropertiesForInitialization. Arguments/results must be
 * serializable data or REMOTE_REQUIRED instances; callbacks are input-only.
 * Remote instances and callbacks cannot be nested in arrays or objects.
 */

const pluginChannels = new Map<string, Map<string, Function>>();

function prepareDatabaseWrite(db: Record<string, any>): Record<string, any> {
    const prepared = { ...db }
    for (const field of ['modules', 'personas']) {
        if (!Object.hasOwn(db, field)) continue
        const items = $state.snapshot(db[field])
        ensureUniqueEntityIds(items)
        prepared[field] = items
    }
    return prepared
}

type PluginEventListenerEntry = {
    pluginName: string;
    eventTarget: EventTarget;
    type: string;
    listener: EventListenerOrEventListenerObject;
    options: AddEventListenerOptions;
};
const pluginEventListeners = new Map<string, PluginEventListenerEntry>();

const removePluginEventListener = (id: string) => {
    const entry = pluginEventListeners.get(id);
    if(!entry) return;
    entry.eventTarget.removeEventListener(entry.type, entry.listener, entry.options);
    pluginEventListeners.delete(id);
}

// Keyboard events are delayed below to reduce their fingerprinting value.
const immediateEventTypes = new Set([
    'click', 'dblclick', 'contextmenu', 'mousedown', 'mouseup', 'mousemove',
    'mouseover', 'mouseleave', 'pointercancel', 'pointerdown', 'pointerenter',
    'pointerleave', 'pointermove', 'pointerout', 'pointerover', 'pointerup',
    'scroll', 'scrollend',
]);
const delayedEventTypes = new Set(['keydown', 'keyup', 'keypress']);

class SafeElement {
    #element: HTMLElement;
    #eventTarget: EventTarget;
    #eventIds = new Set<string>();
    protected readonly pluginName: string;
    __classType = 'REMOTE_REQUIRED' as const;

    constructor(element: HTMLElement, pluginName: string, eventTarget: EventTarget = element) {
        if(element.getAttribute('freezed')){
            throw new Error("This element cannot be accessed by SafeELement")
        }
        this.#element = element;
        this.#eventTarget = eventTarget;
        this.pluginName = pluginName;
    }

    public appendChild(child: SafeElement) {
        this.#element.appendChild(child.#element);
    }

    public removeChild(child: SafeElement) {
        this.#element.removeChild(child.#element);
    }

    public replaceChild(newChild: SafeElement, oldChild: SafeElement) {
        this.#element.replaceChild(newChild.#element, oldChild.#element);
    }

    public replaceWith(newElement: SafeElement) {
        this.#element.replaceWith(newElement.#element);
    }

    public cloneNode(deep: boolean = false): SafeElement {
        const cloned = this.#element.cloneNode(deep);
        return new SafeElement(cloned as HTMLElement, this.pluginName);
    }

    public prepend(child: SafeElement) {
        this.#element.prepend(child.#element);
    }

    public remove() {
        this.#element.remove();
    }

    public innerText(): string {
        return this.#element.innerText;
    }

    public textContent(): string | null {
        return this.#element.textContent;
    }

    public setTextContent(value: string) {
        this.#element.textContent = value;
    }

    public setInnerText(value: string) {
        this.#element.innerText = value;
    }


    public setAttribute(name: string, value: string) {
        if(!name.startsWith('x-')){
            throw new Error("Can only set attributes starting with 'x-' for security reasons. for other attributes, use dedicated methods.");
        }
        this.#element.setAttribute(name, value);
    }
    public getAttribute(name: string): string | null {
        if(!name.startsWith('x-')){
            throw new Error("Can only get attributes starting with 'x-' for security reasons. for other attributes, use dedicated methods.");
        }
        return this.#element.getAttribute(name);
    }
    public setStyle(property: string, value: string) {
        (this.#element.style as any)[property] = value;
    }
    public getStyle(property: string): string {
        return (this.#element.style as any)[property];
    }
    public getStyleAttribute(): string {
        return this.#element.getAttribute('style') || '';
    }
    public setStyleAttribute(value: string) {
        this.#element.setAttribute('style', value);
    }
    public addClass(className: string) {
        this.#element.classList.add(className);
    }
    public removeClass(className: string) {
        this.#element.classList.remove(className);
    }
    public setClassName(className: string){
        this.#element.className = className
    }
    public getClassName(){
        return this.#element.className
    }
    public hasClass(className: string): boolean {
        return this.#element.classList.contains(className);
    }
    public focus() {
        this.#element.focus();
    }
    public getChildren(): SafeClassArray<SafeElement> {
        const children: SafeElement[] = [];
        this.#element.childNodes.forEach(node => {
            if(node instanceof HTMLElement) {
                children.push(new SafeElement(node, this.pluginName));
            }
        });
        return new SafeClassArray<SafeElement>(children);
    }
    public getParent(): SafeElement | null {
        if(this.#element.parentElement) {
            return new SafeElement(this.#element.parentElement, this.pluginName);
        }
        return null;
    }
    public getInnerHTML(): string {
        return this.#element.innerHTML;
    }
    public getOuterHTML(): string {
        return this.#element.outerHTML;
    }
    public clientHeight(): number {
        return this.#element.clientHeight;
    }
    public clientWidth(): number {
        return this.#element.clientWidth;
    }
    public clientTop(): number {
        return this.#element.clientTop;
    }
    public clientLeft(): number {
        return this.#element.clientLeft;
    }
    public nodeName(): string {
        return this.#element.nodeName;
    }
    public nodeType(): number {
        return this.#element.nodeType;
    }
    public querySelectorAll(selector: string): SafeClassArray<SafeElement> {
        const nodeList = this.#element.querySelectorAll(selector);
        const elements: SafeElement[] = [];
        nodeList.forEach(node => {
            if(node instanceof HTMLElement) {
                elements.push(new SafeElement(node, this.pluginName));
            }
        });
        return new SafeClassArray<SafeElement>(elements);
    }
    public querySelector(selector: string): SafeElement | null {
        const element = this.#element.querySelector(selector);
        if(element instanceof HTMLElement) {
            return new SafeElement(element, this.pluginName);
        }
        return null;
    }
    public getElementById(id: string): SafeElement | null {
        const element = this.querySelector('#' + id);
        return element;
    }
    public getElementsByClassName(className: string): SafeClassArray<SafeElement> {
        return this.querySelectorAll('.' + className);
    }
    public getClientRects(): DOMRectList {
        return this.#element.getClientRects();
    }
    public getBoundingClientRect(): DOMRect {
        return this.#element.getBoundingClientRect();
    }
    public setInnerHTML(value: string) {
        const san = DOMPurify.sanitize(value);
        this.#element.innerHTML = san;
    }
    public setOuterHTML(value: string) {
        const san = DOMPurify.sanitize(value);
        this.#element.outerHTML = san;
    }
    public scrollIntoView(options?: boolean | ScrollIntoViewOptions) {
        this.#element.scrollIntoView(options);
    }
    public async addEventListener(type:string, listener: (event: any) => void, options?: boolean | AddEventListenerOptions):Promise<string> {
        const realOptions = typeof options === 'boolean' ? { capture: options } : options || {};

        const id = createEntityId()

        const trimEvent = (event: MouseEvent | KeyboardEvent | Event) => {
            if(event instanceof MouseEvent){
                return {
                    type: event.type,
                    clientX: event.clientX,
                    clientY: event.clientY,
                    button: event.button,
                    buttons: event.buttons,
                    altKey: event.altKey,
                    ctrlKey: event.ctrlKey,
                    shiftKey: event.shiftKey,
                    metaKey: event.metaKey,
                }
            }
            else if(event instanceof KeyboardEvent){
                return {
                    type: event.type,
                    key: event.key,
                    code: event.code,
                    repeat: event.repeat,
                    altKey: event.altKey,
                    ctrlKey: event.ctrlKey,
                    shiftKey: event.shiftKey,
                    metaKey: event.metaKey,
                }
            }
            else{
                return {
                    type: event.type
                }
            }

        }

        if (!immediateEventTypes.has(type) && !delayedEventTypes.has(type)) {
            throw new Error(`Event listener of type '${type}' is not allowed for security reasons.`);
        }
        const modifiedListener = (event: Event) => {
            if (!delayedEventTypes.has(type)) {
                listener(trimEvent(event));
                return;
            }
            let delay = 0;
            try {
                delay = (crypto.getRandomValues(new Uint32Array(1))[0] / 100) % 100;
            } catch {}
            setTimeout(() => {
                if (pluginEventListeners.has(id)) listener(trimEvent(event));
            }, delay);
        };
        pluginEventListeners.set(id, {
            pluginName: this.pluginName, eventTarget: this.#eventTarget,
            type, listener: modifiedListener, options: realOptions,
        });
        this.#eventIds.add(id);
        this.#eventTarget.addEventListener(type, modifiedListener, realOptions);
        return id;
    }

    public removeEventListener(_type: string, id: string, _options?: boolean | EventListenerOptions) {
        // Listener IDs determine removal; type/options remain for API compatibility.
        if (this.#eventIds.delete(id)) removePluginEventListener(id);
    }

    public matches (selector: string): boolean {
        return this.#element.matches(selector);
    }
}

class SafeDocument extends SafeElement {
    __classType = 'REMOTE_REQUIRED' as const;
    constructor(document: Document, pluginName: string) {
        super(document.documentElement, pluginName, document);
    }
    createElement(tagName: string): SafeElement {
        if(!tagWhitelist.includes(tagName.toLowerCase())) {
            console.warn(`Creation of <${tagName}> elements is restricted. Creating a <div> instead.`);
            tagName = 'div';
        }
        if(tagName.toLowerCase() === 'a'){
            console.warn(`<a> can be created but href attribute cannot be set directly for security reasons. Use .createAnchorElement(href: string) to create safe anchor elements.`);
        }
        const element = document.createElement(tagName);
        return new SafeElement(element, this.pluginName);
    }
    createAnchorElement(href: string): SafeElement {
        const anchor = document.createElement('a');
        try {
            const url = new URL(href);
            if(url.protocol !== 'http:' && url.protocol !== 'https:'){
                throw new Error("Invalid protocol");
            }
            anchor.setAttribute('href', url.toString());
        } catch (error) {
            console.warn(`Invalid URL provided for anchor element: ${href}. Setting href to '#' instead.`);
            anchor.setAttribute('href', '#');
        }
        return new SafeElement(anchor, this.pluginName);
    }
}

type SafeMutationRecordObject = {
    type: string;
    target: SafeElement;
    addedNodes: SafeElement[];
}

class SafeClassArray<T> {
    #items: T[];
    __classType = 'REMOTE_REQUIRED' as const;
    constructor(items: T[] = []) {
        this.#items = items;
    }
    at(index: number): T {
        return this.#items.at(index);
    }
    length(): number {
        return this.#items.length;
    }
    push(item: T) {
        this.#items.push(item);
    }
}

class SafeMutationRecord{
    __classType = 'REMOTE_REQUIRED' as const;
    #type: string;
    #target: SafeElement;
    #addedNodes: SafeClassArray<SafeElement>;
    constructor(type: string, target: SafeElement, addedNodes: SafeElement[]) {
        this.#type = type;
        this.#target = target;
        this.#addedNodes = new SafeClassArray<SafeElement>(addedNodes);
    }
    getType(): string {
        return this.#type;
    }
    getTarget(): SafeElement {
        return this.#target;
    }
    getAddedNodes(): SafeClassArray<SafeElement> {
        return this.#addedNodes;
    }
}

type SafeMutationCallback = (mutations: SafeClassArray<SafeMutationRecord>) => void;

class SafeMutationObserver {
    #observer: MutationObserver;
    __classType = 'REMOTE_REQUIRED' as const;
    constructor(callback: SafeMutationCallback, pluginName: string) {
        this.#observer = new MutationObserver((mutations) => {
            const safeMutations: SafeMutationRecordObject[] = mutations.map(mutation => {

                const elementMapHelper = (nodeList: NodeList): SafeElement[] => {
                    const elements: SafeElement[] = [];
                    nodeList.forEach(node => {
                        if(node instanceof HTMLElement) {
                            elements.push(new SafeElement(node, pluginName));
                        }
                    })
                    return elements;
                }

                return {
                    type: mutation.type,
                    target: new SafeElement(mutation.target as HTMLElement, pluginName),
                    addedNodes: elementMapHelper(mutation.addedNodes),
                    removedNodes: elementMapHelper(mutation.removedNodes)
                    
                }
            })

            const safeClassed = new SafeClassArray<SafeMutationRecord>([]);
            for(const record of safeMutations){
                safeClassed.push(new SafeMutationRecord(
                    record.type,
                    record.target,
                    record.addedNodes
                ));
            }
            callback(safeClassed);
        });
    }

    observe(element:SafeElement, options: MutationObserverInit) {
        const identifier = createEntityId();
        element.setAttribute('x-identifier', identifier);
        const rawElement = document.querySelector(`[x-identifier="${identifier}"]`) as HTMLElement;
        if(rawElement){
            this.#observer.observe(rawElement, options);
            element.setAttribute('x-identifier', '');
        }
    }

    disconnect() {
        this.#observer.disconnect();
    }

}

const pluginUnloadCallbacks: Map<string, Function[]> = new Map();

const addPluginUnloadCallback = (pluginName: string, callback: Function) => {
    if(!pluginUnloadCallbacks.has(pluginName)){
        pluginUnloadCallbacks.set(pluginName, []);
    }
    pluginUnloadCallbacks.get(pluginName)?.push(callback);
}

const makeMenuUnloadCallback = (menuId:string, menuStore: MenuDef[]) =>{
    return () => {
        const index = menuStore.findIndex(item => item.id === menuId);
        if(index !== -1){
            menuStore.splice(index, 1);
        }
    }
}

const removeChatPanel = (id: string) => {
    const index = chatPanelStore.findIndex(item => item.id === id);
    if(index !== -1){
        chatPanelStore.splice(index, 1);
    }
}

const removePluginChatPanels = (pluginName: string) => {
    for(let i = chatPanelStore.length - 1; i >= 0; i--){
        if(chatPanelStore[i].pluginName === pluginName){
            chatPanelStore.splice(i, 1);
        }
    }
}

const unloadV3Plugin = async (pluginName: string) => {
    const callbacks = pluginUnloadCallbacks.get(pluginName);
    const instance = v3PluginInstances.find(p => p.name === pluginName);
    if(instance){
        const index = v3PluginInstances.findIndex(p => p.name === pluginName);
        if(index !== -1){
            v3PluginInstances.splice(index, 1);
        }
    }
    if(callbacks){
        pluginUnloadCallbacks.delete(pluginName); 
        const promises = callbacks.map(async callback => {
            try {
                await callback();
            } catch (error) {
                console.error(`Error unloading plugin ${pluginName}:`, error);
            }
        });

        await Promise.race([
            Promise.all(promises),
            sleep(1000)
        ])
    }
    for(const [id, entry] of pluginEventListeners){
        if(entry.pluginName === pluginName) removePluginEventListener(id);
    }
    // Failed registration may leave channels without an unload callback.
    pluginChannels.delete(pluginName);
    try {
        instance?.host?.terminate();        
    } catch (error) {
        console.error(`Error terminating plugin ${pluginName}:`, error);
    }
}

// PocketRisu keeps both decisions until reset; scope them to the executing code.
const pluginPermissions = new Map<string, boolean>();
const pluginPermissionStateKey = 'cache/plugin-permissions/state.json';
let pluginPermissionLoadPromise: Promise<void> | null = null;

async function ensurePluginPermissionStateLoaded() {
    pluginPermissionLoadPromise ??= (async () => {
        const payload = await readPersistentJson<{
            decisions?: [string, boolean][]
        }>(pluginPermissionStateKey)
        for (const [key, granted] of payload?.decisions ?? []) {
            pluginPermissions.set(key, granted)
        }
    })()
    await pluginPermissionLoadPromise
}

export async function resetAllPluginPermissions() {
    await ensurePluginPermissionStateLoaded()
    pluginPermissions.clear()
    await removePersistentKey(pluginPermissionStateKey)
}

export async function resetPluginPermission(pluginName: string) {
    const plugin = DBState.db.plugins?.find(plugin => plugin.name === pluginName)
    if (!plugin?.script) return
    const prefix = `${await hasher(new TextEncoder().encode(plugin.script))}_`
    await ensurePluginPermissionStateLoaded()
    for (const key of pluginPermissions.keys()) {
        if (key.startsWith(prefix)) pluginPermissions.delete(key)
    }
    await persistPluginPermissionState()
}

async function persistPluginPermissionState() {
    await writePersistentJson(pluginPermissionStateKey, {
        decisions: [...pluginPermissions],
    })
}

type PluginV3ProviderOptions = {
    model?: Partial<LLMModel>
}

// Module-level rune so model/profile pickers react when API 3.0 plugins finish
// registering providers asynchronously after their UI has already mounted.
export const customV3ProviderMetaStore:LLMModel[] = $state([])

// Plugins share alertStore, so concurrent permission dialogs would overwrite each other.
const pluginPermissionDialogQueue = new PluginPermissionDialogQueue()

const getPluginPermission = async (
    pluginName: string,
    scriptHash: string,
    permissionDesc: PluginPermissionDesc,
) => {
    await ensurePluginPermissionStateLoaded()
    const permissionKey = `${scriptHash}_${permissionDesc}`
    return pluginPermissionDialogQueue.request(
        async () => pluginPermissions.get(permissionKey),
        async (): Promise<boolean> => {
            const alertTitle =
                permissionDesc === 'fetchLogs' ? language.fetchLogConsent(pluginName)
                : permissionDesc === 'db' ? language.getFullDatabaseConsent(pluginName)
                : permissionDesc === 'mainDom' ? language.mainDomAccessConsent(pluginName)
                : permissionDesc === 'replacer' ? language.replacerPermissionConsent(pluginName)
                : permissionDesc === 'provider' ? language.providerPermissionConsent(pluginName)
                : permissionDesc === 'sendChat' ? language.sendChatConsent(pluginName)
                : permissionDesc === 'inlay' ? language.inlayPermissionConsent(pluginName)
                : `Error`
            if(alertTitle === 'Error'){
                return false;
            }
            const conf = await alertConfirm(alertTitle)
            pluginPermissions.set(permissionKey, conf);
            await persistPluginPermissionState()
            if (!conf) await alertNormalWait(language.pluginPermissionDenyGuide.replace("{}", pluginName))
            return conf;
        },
    )
}

const providerRequestContextMetadataKey = 'risuai.pluginProviderRequestContext'

type SanitizedPluginFetchOptions = Pick<FetchNativeArgs,
    'body' | 'headers' | 'method' | 'signal' | 'requestTimeoutMs'
> & {
    method: NonNullable<FetchNativeArgs['method']>
    headers: Record<string, string>
    rawResponse?: boolean
}

const pluginDirectRequestPolicy = {
    kind: 'ephemeral',
    durability: 'off',
    providerRoute: 'direct',
} as const satisfies LLMExecutionPolicy

function sanitizePluginFetchOptions(options: any): SanitizedPluginFetchOptions {
    return {
        method: options?.method?.toUpperCase() ?? 'POST',
        body: options?.body,
        headers: Object.fromEntries(new Headers(options?.headers).entries()),
        signal: options?.signal,
        requestTimeoutMs: options?.requestTimeoutMs,
    }
}

function sanitizeRisuFetchOptions(options: any): SanitizedPluginFetchOptions {
    const form = options?.body instanceof URLSearchParams
    const normalized = sanitizePluginFetchOptions(options)
    normalized.headers['content-type'] ??= form ? 'application/x-www-form-urlencoded' : 'application/json'
    return {
        ...normalized,
        body: form ? options.body.toString() : JSON.stringify(options?.body) ?? '',
        signal: options?.abortSignal ?? options?.signal,
        rawResponse: options?.rawResponse,
    }
}

const makeRisuaiAPIV3 = (iframe:HTMLIFrameElement,plugin:RisuPlugin) => {

    const apis = createPluginApis(plugin.name);
    const pluginName = plugin.name
    const pluginScript = plugin.script
    let scriptHash: Promise<string> | undefined
    const getPermission = async (permission: PluginPermissionDesc) => {
        scriptHash ??= hasher(new TextEncoder().encode(pluginScript))
        return getPluginPermission(pluginName, await scriptHash, permission)
    }
    const pluginRequestContexts = new Map<string, PluginProviderRequestContext>()
    const activeProviderRequestContext = (signal: AbortSignal | undefined): PluginProviderRequestContext | undefined => {
        const contextToken = getRpcAbortSignalMetadata(signal, providerRequestContextMetadataKey)
        return resolveProviderRequestContext(pluginRequestContexts, contextToken)
    }
    const providerFetchContext = (
        url: string,
        options: PluginProviderFetchOptions | undefined,
        requestContext: PluginProviderRequestContext | undefined,
    ): (PluginProviderRequestContext & { responseDecoder?: AdapterResponseDecoder }) | undefined => {
        if (!requestContext) return undefined
        const classification = classifyPluginProviderFetch(
            url,
            options,
            requestContext.generationRequest?.workflow?.dependency?.placeholder,
        )
        if (!classification.generation) return undefined
        return {
            ...requestContext,
            responseDecoder: classification.responseDecoder,
            generationRequest: requestContext.generationRequest ? {
                ...requestContext.generationRequest,
                job: {
                    ...requestContext.generationRequest.job,
                    adapterKind: requestContext.generationRequest.job.adapterKind
                        ?? classification.responseDecoder?.adapterKind,
                },
            } : undefined,
        }
    }
    const getConfiguredComfyUrls = () => {
        try {
            const settings = getCurrentImageGenerationPreset(getDatabase()).settings
            const url = settings.sdProvider === 'comfyui' ? settings.comfyUiUrl : ''
            return typeof url === 'string' && url.trim() ? [url] : []
        } catch {
            return []
        }
    }
    const fetchPluginNetwork = async (url: string, safeOptions: SanitizedPluginFetchOptions, legacyStringBody?: string) => {
        const providerContext = activeProviderRequestContext(safeOptions.signal)
        const { url: authorizedUrl, useServer } = authorizePluginRequest(url, {
            keiUrl: window.location.href,
            comfyUrls: getConfiguredComfyUrls(),
            providerActive: !!providerContext,
            method: safeOptions.method,
        })
        const generationContext = useServer
            ? providerFetchContext(authorizedUrl, legacyStringBody === undefined
                ? safeOptions : { ...safeOptions, body: legacyStringBody }, providerContext)
            : undefined
        const { rawResponse: _rawResponse, ...nativeOptions } = safeOptions
        const requestOptions: FetchNativeArgs = {
            ...nativeOptions,
            // globalFetch's generation path forwards pre-encoded strings verbatim.
            ...(legacyStringBody !== undefined && generationContext?.generationRequest && generationContext.interceptor
                ? { body: legacyStringBody } : {}),
            llmExecutionPolicy: useServer
                ? generationContext?.llmExecutionPolicy
                    ? { ...generationContext.llmExecutionPolicy, providerRoute: 'server' }
                    : EPHEMERAL_SERVER_LLM_EXECUTION
                : pluginDirectRequestPolicy,
            ...(useServer ? {} : { redirect: 'error' }),
            ...(generationContext ? {
                chatId: generationContext.chatId,
                generationRequest: generationContext.generationRequest,
                responseDecoder: generationContext.responseDecoder,
                interceptor: generationContext.interceptor,
            } : {}),
        }
        return await apis.nativeFetch(authorizedUrl, requestOptions)
    }
    return {
        risuFetch: async (url, options) => {
            console.error(`[DEPRECATION WARNING] risuFetch is deprecated and will be removed in future versions. Please use nativeFetch instead.`)
            let safeOptions: SanitizedPluginFetchOptions
            try {
                safeOptions = sanitizeRisuFetchOptions(options)
                const response = await fetchPluginNetwork(url, safeOptions,
                    typeof options?.body === 'string' ? options.body : undefined)
                return await readGlobalFetchResponse(response, safeOptions.rawResponse)
            } catch (error) {
                return { ok: false, data: `${error}`, headers: {}, status: 400 }
            }
        },
        nativeFetch: async (url, options) => {
            const safeOptions = sanitizePluginFetchOptions(options)
            return fetchPluginNetwork(url, safeOptions)
        },
        getChar: apis.getChar,
        setChar: apis.setChar,
        addProvider: (name: string, func: PluginProviderFunction, options?: PluginV3ProviderOptions) => {
            console.warn(`[WARN] addProvider is a powerful API that can potentially be unsafe if used incorrectly. addProvider's functionality might be limited or changed in future updates to ensure security. please use other APIs if possible.`);
            const provider = async (arg: PluginProviderArgument, abortSignal?: AbortSignal) => {
               const conf = await getPermission('provider');
               if(!conf){
                   return { success: false, content: `Provider permission denied for plugin '${plugin.name}'` };
               }
               arg.mode = 'v3'
               const requestContext = arg[pluginProviderRequestContextKey]
               if (!requestContext) {
                   return await func(arg, abortSignal);
               }

               const contextToken = createEntityId()
               const contextSignal = abortSignal ?? new AbortController().signal
               if (abortSignal) {
                   setRpcAbortSignalMetadata(abortSignal, providerRequestContextMetadataKey, contextToken)
               }
               return await withProviderRequestContext(
                   pluginRequestContexts, contextToken, requestContext, contextSignal,
                   () => func(arg, abortSignal),
               );
            }
            pluginRuntime.providers.set(name, provider)

            const modelData:LLMModel = $state({
                id: `pluginmodel:::${name}`,
                name: options?.model?.name ?? name,
                shortName: options?.model?.shortName ?? name,
                fullName: options?.model?.fullName ?? name,
                internalID: options?.model?.internalID ?? `pluginmodel:::${name}`,
                provider: LLMProvider.AsIs,
                format: LLMFormat.Plugin,
                flags: options?.model?.flags ?? [LLMFlags.hasFullSystemPrompt],
                parameters: options?.model?.parameters ?? ['temperature', 'top_p', 'frequency_penalty', 'presence_penalty', 'repetition_penalty', 'min_p', 'top_a', 'top_k', 'thinking_tokens'],
                tokenizer:options?.model?.tokenizer ??  LLMTokenizer.Unknown
            })
            customV3ProviderMetaStore.push(modelData);
            addPluginUnloadCallback(plugin.name, () => {
                if(pluginRuntime.providers.get(name) === provider) pluginRuntime.providers.delete(name);

                const metaIndex = customV3ProviderMetaStore.indexOf(modelData);
                if(metaIndex !== -1) customV3ProviderMetaStore.splice(metaIndex, 1);
            });
        },
        addTTSPreprocessor: async (
            func: TTSHookFn<BeforeTTSContext, BeforeTTSResult>,
        ) => {
            registerTTSPreprocessor(func);
            addPluginUnloadCallback(plugin.name, () => unregisterTTSPreprocessor(func));
        },
        addTTSPostprocessor: async (
            func: TTSHookFn<AfterTTSContext, AfterTTSResult>,
        ) => {
            registerTTSPostprocessor(func);
            addPluginUnloadCallback(plugin.name, () => unregisterTTSPostprocessor(func));
        },
        addRisuScriptHandler: (...args: Parameters<typeof apis.addRisuScriptHandler>) => {
            apis.addRisuScriptHandler(...args)
            addPluginUnloadCallback(plugin.name, () => apis.removeRisuScriptHandler(...args))
        },
        removeRisuScriptHandler: apis.removeRisuScriptHandler,
        addRisuReplacer: async (name:string,func:Function) => {
            const conf = await getPermission('replacer');
            if(!conf){
                return;
            }
            apis.addRisuReplacer(name, func as any);
            addPluginUnloadCallback(plugin.name, () => apis.removeRisuReplacer(name, func as any));
        },
        removeRisuReplacer: apis.removeRisuReplacer,
        addRisuChatListener: async (mode:'output', func:Function) => {
            const conf = await getPermission('replacer');
            if(!conf) return;
            apis.addRisuChatListener(mode, func as any);
            addPluginUnloadCallback(plugin.name, () => apis.removeRisuChatListener(mode, func as any));
        },
        removeRisuChatListener: apis.removeRisuChatListener,
        setDatabaseLite: (db: Record<string, any>) => {
            const prepared = prepareDatabaseWrite(db)
            delete prepared.plugins
            return apis.setDatabaseLite(prepared)
        },
        setDatabase: (db: Record<string, any>) => apis.setDatabase(prepareDatabaseWrite(db)),
        loadPlugins: apis.loadPlugins,
        readImage: apis.readImage,
        readInlay: async (id: string) => {
            const conf = await getPermission('inlay');
            if(!conf){
                return null;
            }
            return await getInlayAsset(id);
        },
        saveAsset: apis.saveAsset,
        getDatabase: async (includeOnly:string[]|'all' = 'all') => {
            const conf = await getPermission('db');
            if(!conf){
                return null;
            }
            const db = DBState.db
            let liteDB = {}
            for(const key of allowedDbKeys){
                if(includeOnly !== 'all' && !includeOnly.includes(key)){
                    continue;
                }
                const value = $state.snapshot((db as any)[key]);
                (liteDB as any)[key] = key === 'characters' ? value.map(withChatSelection) : value;
            }
            return liteDB;
        },

        installPlugin: handlePluginInstallViaPlugin,

        // --- Color Scheme APIs ---
        changeColorScheme: (name: string) => {
            changeColorScheme(name)
        },
        setColorScheme: (scheme: ColorScheme | LegacyColorScheme) => {
            const normalizedScheme = normalizeColorScheme(scheme)
            if(normalizedScheme == null){
                throw new Error('Invalid color scheme')
            }
            const db = DBState.db
            db.colorSchemeName = 'custom'
            db.colorScheme = normalizedScheme
            updateColorScheme()
        },
        getColorScheme: () => {
            const db = DBState.db
            return {
                name: db.colorSchemeName,
                scheme: withLegacyColorSchemeAliases($state.snapshot(db.colorScheme))
            }
        },

        // --- Text Theme APIs ---
        changeTextTheme: (name: string) => {
            if (!['standard','highcontrast'].includes(name)) {
                throw new Error(`Invalid text theme: ${name}`)
            }
            const db = DBState.db
            db.textTheme = name
            updateTextThemeAndCSS()
        },
        setCustomTextTheme: (theme: {
            FontColorStandard: string,
            FontColorBold: string,
            FontColorItalic: string,
            FontColorItalicBold: string,
            FontColorQuote1: string,
            FontColorQuote2: string
        }) => {
            const requiredKeys = ['FontColorStandard','FontColorBold','FontColorItalic','FontColorItalicBold','FontColorQuote1','FontColorQuote2'] as const
            for (const key of requiredKeys) {
                if (typeof (theme as any)[key] !== 'string') {
                    throw new Error(`Invalid text theme: missing or invalid '${key}'`)
                }
            }
            const db = DBState.db
            db.textTheme = 'custom'
            db.customTextTheme = theme
            updateTextThemeAndCSS()
        },
        getTextTheme: () => {
            const db = DBState.db
            return {
                name: db.textTheme,
                customTheme: $state.snapshot(db.customTextTheme)
            }
        },

        getArg: apis.getArg,
        setArg: apis.setArg,
        getArgument: async (key:string) => {
            const db = getDatabase()
            for (const p of db.plugins) {
                if (p.name === plugin.name) {
                    return p.realArg[key];
                }
            }
        },
        setArgument: async (key:string, value:string) => {
            const db = getDatabase();
            for (const p of db.plugins) {
                if (p.name === plugin.name) {
                    p.realArg[key] = value;
                }
            }
        },
        getCharacterFromIndex: (index:number) => {
            const db = DBState.db
            const charIds = Object.keys(db.characters);
            const charId = charIds[index];
            if(charId){
                return withChatSelection($state.snapshot(db.characters[charId]));
            }
            return null;
        },
        setCharacterToIndex: (index:number, char:any) => {
            const db = DBState.db
            const charIds = Object.keys(db.characters);
            const charId = charIds[index];
            if(charId){
                initializeChatSelection(char, true)
                DBState.db.characters[charId] = char
            }
        },
        getChatFromIndex,
        parseRisuChat: async (text:string, options?:{
            messageIndex?: number
            role?: string
            processRegex?: boolean
            runVar?: boolean
            rmVar?: boolean
            tokenizeAccurate?: boolean
            cbsConditions?: CbsConditions
        }) => {
            const db = DBState.db
            const char = db.characters[get(selectedCharID)];
            if(!char){
                throw new Error('No character selected');
            }
            const chat = char.chats?.[getChatPage(char)];
            if(!chat){
                throw new Error('No active chat found');
            }
            const chatID = options?.messageIndex ?? -1;
            if(!Number.isInteger(chatID) || chatID < -1 || chatID >= chat.message.length){
                throw new Error(`Invalid messageIndex: ${chatID}`);
            }
            const role = options?.role;
            const cbsConditions:CbsConditions = {
                ...(role ? { chatRole: role } : {}),
                ...(options?.cbsConditions ?? {}),
            };
            const parsed = risuChatParser(text ?? '', {
                chara: char,
                chatID,
                role,
                runVar: options?.runVar,
                rmVar: options?.rmVar,
                tokenizeAccurate: options?.tokenizeAccurate,
                cbsConditions,
            });

            if(!options?.processRegex){
                return parsed;
            }

            return (await processScriptFull(char, parsed, 'editprocess', chatID, cbsConditions)).data;
        },
        setChatToIndex,
        getCurrentCharacterIndex: () => {
            return get(selectedCharID)
        },
        getCurrentChatIndex: () => {
            const db = DBState.db
            const charId = get(selectedCharID)
            return getChatPage(db.characters[charId])
        },
        getCurrentLorebookEntries: () => {
            const charId = get(selectedCharID)
            const char = DBState.db.characters[charId]
            if(!char){
                return []
            }
            const page = getChatPage(char)
            const characterLore = char.globalLore ?? []
            const chatLore = char.chats?.[page]?.localLore ?? []
            const moduleLore = getModuleLorebooks()
            return $state.snapshot(characterLore.concat(chatLore).concat(moduleLore))
        },
        getCharacter: apis.getChar,
        setCharacter: apis.setChar,

        showContainer: (
            type: 'fullscreen' = 'fullscreen'
        ) => {
            iframe.style.display = "block";
            
            switch(type) {
                case 'fullscreen': {
                    if(iframe.parentElement !== document.body) {
                        document.body.appendChild(iframe);
                    }
                    iframe.style.position = "fixed";
                    iframe.style.top = "0";
                    iframe.style.left = "0";
                    iframe.style.width = "100%";
                    iframe.style.height = "100%";
                    iframe.style.border = "none";
                    iframe.style.zIndex = layerZIndexes.overlay;
                    break;
                }
                default: {
                    return
                }
            }
        },
        hideContainer: () => {
            iframe.style.display = "none";
        },
        getRootDocument: async () => {
            const conf = await getPermission('mainDom');
            if(!conf){
                return null;
            }
            return new SafeDocument(document, plugin.name);
        },
        registerSetting: (
            name:string,
            callback: any,
            icon:string = '',
            iconType:'html'|'img'|'none' = 'none',
            id?:string
        ) => {
            if(iconType !== 'html' && iconType !== 'img' && iconType !== 'none'){
                throw new Error("iconType must be 'html', 'img' or 'none'");
            }
            if(typeof name !== 'string' || name.trim() === ''){
                throw new Error("name must be a non-empty string");
            }
            const menuId = id || createEntityId()
            const menuDef:MenuDef = {
                id: menuId,
                name,
                icon,
                iconType,
                callback
            }
            const existingIndex = additionalSettingsMenu.findIndex(item => item.id === menuId)
            if(existingIndex !== -1){
                additionalSettingsMenu[existingIndex] = menuDef
                addPluginUnloadCallback(
                    plugin.name,
                    makeMenuUnloadCallback(menuId, additionalSettingsMenu)
                )
                return {id: menuId}
            }
            additionalSettingsMenu.push(menuDef)
            addPluginUnloadCallback(
                plugin.name,
                makeMenuUnloadCallback(menuId, additionalSettingsMenu)
            )
            return {id: menuId};
        },
        registerBodyIntercepter: async (callback: (body: any, type: string) => any) => {

            if(await getPermission('replacer') === false){
                return null;
            }
            
            const id = createEntityId();
            bodyIntercepterStore.push({
                id,
                callback
            })
            addPluginUnloadCallback(plugin.name, () => {
                const index = bodyIntercepterStore.findIndex(item => item.id === id);
                if(index !== -1){
                    bodyIntercepterStore.splice(index, 1);
                }
            })
            return {id:id};
        },
        
        unregisterBodyIntercepter: (id: string) => {
            const index = bodyIntercepterStore.findIndex(item => item.id === id);
            if(index !== -1){
                bodyIntercepterStore.splice(index, 1);
            }
        },
            
        registerButton: (
            arg: {
                name: string,
                icon: string,
                iconType: 'html'|'img'|'none',
                location?: 'action'|'chat'|'hamburger',
                id?: string
            },
            callback: () => void
        ) => {
            let { name, icon, iconType, location, id: providedId } = arg;
            location = location || 'action';
            if(iconType !== 'html' && iconType !== 'img' && iconType !== 'none'){
                throw new Error("iconType must be 'html', 'img' or 'none'");
            }
            if(typeof name !== 'string' || name.trim() === ''){
                throw new Error("name must be a non-empty string");
            }
            if(typeof icon !== 'string'){
                throw new Error("icon must be a string");
            }
            const id = providedId || createEntityId()
            const sameNameHamburgerCount = location === 'hamburger'
                ? additionalHamburgerMenu.filter((item) => item.pluginName === plugin.name && item.name === name).length
                : 0
            const sidebarKey = location === 'hamburger'
                ? (providedId
                    ? pluginSidebarMenuKey(providedId)
                    : automaticPluginSidebarMenuKey(plugin.name, name, sameNameHamburgerCount))
                : undefined
            const menuDef:MenuDef = {
                name,
                pluginName: plugin.name,
                sidebarKey,
                icon,
                iconType,
                callback,
                id
            }
            const rememberSidebarMenuOwner = () => {
                if (sidebarKey) rememberPluginSidebarMenuItem(DBState.db, sidebarKey, plugin.name)
            }

            const buttonStores = [additionalFloatingActionButtons, additionalHamburgerMenu, additionalChatMenu]
            for(const store of buttonStores){
                const existingIndex = store.findIndex(item => item.id === id)
                if(existingIndex !== -1){
                    store[existingIndex] = menuDef
                    if(store === additionalHamburgerMenu) rememberSidebarMenuOwner()
                    addPluginUnloadCallback(
                        plugin.name,
                        makeMenuUnloadCallback(id, store)
                    )
                    return {id}
                }
            }

            switch(location){
                case 'action':{
                    additionalFloatingActionButtons.push(menuDef)
                    addPluginUnloadCallback(
                        plugin.name,
                        makeMenuUnloadCallback(menuDef.id, additionalFloatingActionButtons)
                    )
                    break
                }
                case 'hamburger':{
                    additionalHamburgerMenu.push(menuDef)
                    rememberSidebarMenuOwner()
                    addPluginUnloadCallback(
                        plugin.name,
                        makeMenuUnloadCallback(menuDef.id, additionalHamburgerMenu)
                    )
                    break
                }
                case 'chat':{
                    additionalChatMenu.push(menuDef)
                    addPluginUnloadCallback(
                        plugin.name,
                        makeMenuUnloadCallback(menuDef.id, additionalChatMenu)
                    )
                    break
                }
                default:{
                    throw new Error("Invalid location for button")
                }
            }
            return {id};
        },
        setChatPanel: (
            content: string | null,
            options: {
                id?: string,
                className?: string,
            } = {}
        ) => {
            const id = options.id || `${plugin.name}:default`;

            if(content === null || content === ''){
                removeChatPanel(id);
                return {id};
            }

            if(typeof content !== 'string'){
                throw new Error("content must be a string or null");
            }

            const panel = {
                id,
                pluginName: plugin.name,
                html: DOMPurify.sanitize(content),
                className: typeof options.className === 'string'
                    ? DOMPurify.sanitize(options.className, {ALLOWED_TAGS: [], ALLOWED_ATTR: []})
                    : undefined,
            }

            const existingIndex = chatPanelStore.findIndex(item => item.id === id);
            if(existingIndex !== -1){
                chatPanelStore[existingIndex] = panel;
            }
            else{
                chatPanelStore.push(panel);
            }
            addPluginUnloadCallback(plugin.name, () => removePluginChatPanels(plugin.name));
            return {id};
        },
        registerMCP: registerMCPModule,
        unregisterMCP: unregisterMCPModule,
        unregisterUIPart: (id: string) => {
            const hamburgerMenu = additionalHamburgerMenu.find((item) => item.id === id)
            const removeFromMenuStore = (menuStore: MenuDef[]) => {
                const index = menuStore.findIndex(item => item.id === id);
                if(index !== -1){
                    menuStore.splice(index, 1);
                }
            }

            removeFromMenuStore(additionalSettingsMenu);
            removeFromMenuStore(additionalFloatingActionButtons);
            removeFromMenuStore(additionalHamburgerMenu);
            if(hamburgerMenu) removeSidebarMenuKeys(
                DBState.db,
                [hamburgerMenu.sidebarKey ?? pluginSidebarMenuKey(hamburgerMenu.id)],
            )
            removeFromMenuStore(additionalChatMenu);
            removeChatPanel(id);
        },
        log: (message:string) => {
            if (isDebugEnabled()) {
                console.debug(`[RisuAI Plugin: ${plugin.name}] ${message}`);
            }
        },
        createMutationObserver(callback: SafeMutationCallback): SafeMutationObserver {
            const observer = new SafeMutationObserver(callback, plugin.name)
            addPluginUnloadCallback(plugin.name, () => observer.disconnect())
            return observer
        },
        onUnload: (callback: () => void) => {
            addPluginUnloadCallback(plugin.name, callback);
        },
        getFetchLogs: async () => {
            const unsafeFetchLog = getFetchLogs()
            const conf = await getPermission('fetchLogs');
            if(!conf){
                return null;
            }
            return unsafeFetchLog.map(log => {

                const url = new URL(log.url);
                return {
                    url: url.origin + url.pathname,
                    body: log.body,
                    status: log.status,
                    response: log.response,
                }
            })
        },

        alert: (msg:string) => {
            return alertNormal(msg)
        },
        alertConfirm: (msg:string) => {
            return alertConfirm(msg)
        },
        alertError: (msg:string) => {
            return alertError(msg)
        },
        getRuntimeInfo: () => {
            return {
                apiVersion: "3.0",
                platform: 'node',
                saveMethod: 'local',
            }
        },
        getLocalPluginStorage: () => {
            return new SafeLocalPluginStorage(plugin.name)
        },
        checkCharOrder: checkCharOrder,
        requestPluginPermission: (permission:string) => {
            return getPermission(permission as PluginPermissionDesc);
        },
        //Internal use APIs
        _getPropertiesForInitialization: () => {
            const v = {
                apiVersion: "3.0",
                apiVersionCompatibleWith: ["3.0"],
            } as any;

            v.list = Object.keys(v);
            
            return v;
        },
        _getPluginStorage: apis.pluginStorage.getItem,
        // Track storage ownership for plugin management.
        _setPluginStorage: (key: string, value: any) => {
            apis.pluginStorage.setItem(key, value)
            recordOwner(key, plugin.name)
        },
        _removePluginStorage: (key: string) => {
            apis.pluginStorage.removeItem(key)
            removeOwner(key)
        },
        _clearPluginStorage: () => {
            apis.pluginStorage.clear()
            clearOwners()
        },
        _keyPluginStorage: apis.pluginStorage.key,
        _keysPluginStorage: apis.pluginStorage.keys,
        _lengthPluginStorage: apis.pluginStorage.length,
        _getSafeLocalStorage: apis.safeLocalStorage.getItem,
        _setSafeLocalStorage: (key: string, value: string) => apis.safeLocalStorage.setItem(key, value),
        _removeSafeLocalStorage: (key: string) => apis.safeLocalStorage.removeItem(key),
        _clearSafeLocalStorage: () => apis.safeLocalStorage.clear(),
        _keySafeLocalStorage: (index: number) => apis.safeLocalStorage.key(index),
        _keysSafeLocalStorage: apis.safeLocalStorage.keys,
        _lengthSafeLocalStorage: () => apis.safeLocalStorage.length,
        searchTranslationCache: async (partialKey: string) => {
            return searchLLMCache(partialKey)
        },
        getTranslationCache: async (key: string) => {
            return getLLMCache(key)
        },
        _getAliases: () => {
            return {
                'pluginStorage':{
                    'getItem': '_getPluginStorage',
                    'setItem': '_setPluginStorage',
                    'removeItem': '_removePluginStorage',
                    'clear': '_clearPluginStorage',
                    'key': '_keyPluginStorage',
                    'keys': '_keysPluginStorage',
                    'length': '_lengthPluginStorage',
                },
                'safeLocalStorage':{
                    'getItem': '_getSafeLocalStorage',
                    'setItem': '_setSafeLocalStorage',
                    'removeItem': '_removeSafeLocalStorage',
                    'clear': '_clearSafeLocalStorage',
                    'key': '_keySafeLocalStorage',
                    'keys': '_keysSafeLocalStorage',
                    'length': '_lengthSafeLocalStorage',
                }
            }
        },
        runLLMModel: async (options: {
            mode: ModelModeExtended
            messages: OpenAIChat[]
            allowPlugins?: boolean
        }) => {
            return requestChatDataMain({
                formated: options.messages,
                bias: {},

                // Require explicit opt-in to avoid recursive calls between provider plugins.
                blockPlugins: !options.allowPlugins,
            }, options.mode)
        },
        sendChat: async (message: string) => {
            const conf = await getPermission('sendChat');
            if(!conf){
                return false;
            }

            if(typeof message !== 'string'){
                throw new Error("Message must be a string");
            }

            if(get(doingChat)){
                throw new Error("A chat is already in progress");
            }

            const charId = get(selectedCharID);
            const char = DBState.db.characters[charId];
            if(!char){
                throw new Error("No character selected");
            }

            const chat = char.chats[getChatPage(char)];
            if(!chat){
                throw new Error("No active chat found");
            }
            const binding = resolveChatModelBinding(chat, 'model');
            if(binding.kind === 'modelPreset' && binding.preset.profileSnapshot.adapterKind === 'plugin'){
                // Keep the existing provider-to-sendChat loop guard effective
                // when the chat selects its plugin through ModelPreset.
                throw new Error("Sending chat with plugin-based model is currently blocked");
            }

            if(message){
                chat.message.push({
                    role: 'user',
                    data: message,
                    time: Date.now(),
                });
            }

            try {
                await processSendChat(-1, {});
            } finally {
                // Plugin API path does not pass through the UI unlock logic,
                // so release doingChat here on both success and failure.
                doingChat.set(false);
            }

            return true;
        },
        addPluginChannelListener: (channelName: string, callback: Function) => {
            let channels = pluginChannels.get(plugin.name);
            if(!channels){
                channels = new Map();
                pluginChannels.set(plugin.name, channels);
            }
            channels.set(channelName, callback);
            addPluginUnloadCallback(plugin.name, () => {
                const currentChannels = pluginChannels.get(plugin.name);
                currentChannels?.delete(channelName);
                if(currentChannels?.size === 0) pluginChannels.delete(plugin.name);
            });
        },
        postPluginChannelMessage: (pluginName: string, channelName: string, message: any) => {

            const currentPluginName = plugin.name;
            const receiverPlugin = DBState.db.plugins.find(p => p.name === pluginName);

            if(!receiverPlugin){
                console.warn(`[RisuAI Plugin: ${currentPluginName}] Attempted to send message to non-existent plugin '${pluginName}' on channel '${channelName}'.`);
                return;
            }

            if(!receiverPlugin.allowedIPC?.includes(currentPluginName)){
                console.warn(`[RisuAI Plugin: ${currentPluginName}] Attempted to send message to plugin '${pluginName}' but receiver plugin does not allow IPC communication from this plugin. declare //@allowed-ipc ${currentPluginName} in the reciver plugin script to allow IPC communication.`);
                return;
            }

            if(!plugin.allowedIPC?.includes(receiverPlugin.name)){
                console.warn(`[RisuAI Plugin: ${currentPluginName}] Attempted to send message to plugin '${pluginName}' but the sender plugin does not allow IPC communication to this plugin. declare //@allowed-ipc ${receiverPlugin.name} in the sender plugin script to allow IPC communication.`);
                return;
            }


            const callback = pluginChannels.get(pluginName)?.get(channelName);
            if(callback){
                callback(message, {
                    sender: currentPluginName,
                    channel: channelName
                });
            }
        },
        saveSecretHeader: async (key: string, value: string|string[]) => {
            console.warn(`[RisuAI Plugin: ${plugin.name}] saveServerSecret is not implemented yet. This API is intended for securely storing sensitive information like API keys with write-only access for plugins. Please avoid using this API until it is implemented.`);
        }
    }
}

type V3PluginInstance = {
    name: string;
    host: SandboxHost;
}

const v3PluginInstances: V3PluginInstance[] = [];

export async function loadV3Plugins(plugins:RisuPlugin[]){
    await Promise.all([...v3PluginInstances].map(async (instance) => {
        await unloadV3Plugin(instance.name);
    }));
    // Failed startup may leave resources without a recorded runtime instance.
    for(const id of pluginEventListeners.keys()){
        removePluginEventListener(id);
    }
    pluginChannels.clear();
    for (const registrations of Object.values(pluginRuntime)) registrations.clear();
    customV3ProviderMetaStore.length = 0;
    const loadPromises = plugins.map(plugin => executePluginV3(plugin));
    await Promise.all(loadPromises);
}

export async function reloadV3Plugin(plugin:RisuPlugin){
    await unloadV3Plugin(plugin.name);
    await executePluginV3(plugin);
}

async function executePluginV3(plugin:RisuPlugin){

    const alreadyRunning = v3PluginInstances.find(p => p.name === plugin.name);
    if(alreadyRunning){
        if (isDebugEnabled()) {
            console.debug(`[RisuAI Plugin: ${plugin.name}] Plugin is already running. Skipping load.`);
        }
        return;
    }

    const iframe = document.createElement('iframe');
    iframe.style.display = "none";
    document.body.appendChild(iframe);
    const host = new SandboxHost(makeRisuaiAPIV3(iframe, plugin));
    v3PluginInstances.push({
        name: plugin.name,
        host
    });
    host.run(iframe, plugin.script);
    if (isDebugEnabled()) {
        console.debug(`[RisuAI Plugin: ${plugin.name}] Loaded API V3 plugin.`);
    }
}

globalThis.__debugV3Plugin = (code: string|Function, pluginName: string = '') => {
    if(code instanceof Function){
        code = `(${code.toString()})()`;
    }
    if(pluginName === ''){
        return v3PluginInstances[0].host.executeInIframe(code);
    }
    const instance = v3PluginInstances.find(p => p.name === pluginName);
    if(!instance){
        throw new Error(`Plugin ${pluginName} not found.`);
    }
    return instance.host.executeInIframe(code);
};
