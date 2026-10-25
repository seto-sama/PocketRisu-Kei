import { get, writable } from "svelte/store"
import { toast } from "svelte-sonner"
import { sleep } from "./util"
import { language } from "../lang"
import { pocketKeiVer, type MessageGenerationInfo } from "./storage/database.svelte"
import { alertStore as alertStoreImported, togglePresetsOpenStore } from "./stores.svelte"
import { addLog } from "./log"
import { PRODUCT_NAME } from "./branding"
import { nativeConsoleError } from "./log-capture"
import type { ButtonVariant } from "../lib/UI/components/Button.types"

export interface AlertAction {
    label: string
    variant?: ButtonVariant
}

export interface AlertSelectOptions {
    display?: string
    /** Defaults to true. Disable only when the caller cannot safely handle cancellation. */
    closeOnOutsideClick?: boolean
}

export interface alertData{
    type: 'error'|'normal'|'none'|'wait'
            |'input'|'markdown'|'select'
            |'cardexport'|'requestdata'|'addchar'|'selectModule'
            |'progress',
    msg: string,
    title?: string,
    progressDetail?: string,
    submsg?: string
    datalist?: [string, string][],
    stackTrace?: string;
    defaultValue?: string
    hideConfirm?: boolean
    closeOnOutsideClick?: boolean
}

export interface NotifyOptions {
    description?: string
    source?: string
    log?: boolean
}

export const requestDiagnosticsTabs = {
    overview: 0,
    prompt: 1,
    requestLog: 2,
} as const
export type RequestDiagnosticsTab = typeof requestDiagnosticsTabs[keyof typeof requestDiagnosticsTabs]

export type AlertGenerationInfoStoreData = {
    genInfo: MessageGenerationInfo,
    idx: number,
    initialTab?: RequestDiagnosticsTab
}
export const alertGenerationInfoStore = writable<AlertGenerationInfoStoreData>(null)
export const alertStore = {
    set: (d:alertData) => {
        alertStoreImported.set(d)
    }
}

type ConfirmationContent =
    | { kind: 'confirm'; message: string; description?: string }
    | { kind: 'multi'; message: string; description?: string; actions: AlertAction[] }
    | { kind: 'terms' }

type ConfirmationDialog = ConfirmationContent & {
    id: symbol
    complete: (result: boolean | number) => void
}

const confirmationState = writable<ConfirmationDialog[]>([])
export const confirmationDialogs = { subscribe: confirmationState.subscribe }

function requestConfirmation(content: ConfirmationContent): Promise<boolean | number> {
    return new Promise(resolve => {
        const id = Symbol('confirmation')
        const dialog: ConfirmationDialog = {
            ...content,
            id,
            complete(result) {
                confirmationState.update(dialogs => dialogs.filter(dialog => dialog.id !== id))
                resolve(result)
            },
        }
        confirmationState.update(dialogs => [...dialogs, dialog])
    })
}

const RISU_TOS_STORAGE_KEY = 'risuTosRevision'
const RISU_TOS_REVISION = '2026-04-11'

function readRisuTosAccepted(): boolean {
    try {
        return localStorage.getItem(RISU_TOS_STORAGE_KEY) === RISU_TOS_REVISION
    } catch {
        return false
    }
}

export const risuTosAccepted = writable(readRisuTosAccepted())

function normalizeErrorMessage(msg: unknown): { message: string; stack?: string } {
    if (typeof msg === 'string') return { message: msg }
    try {
        if (msg instanceof Error) {
            return { message: msg.message || String(msg), stack: msg.stack }
        }
        if (msg && typeof msg === 'object') {
            const errorLike = msg as { message?: unknown; stack?: unknown }
            const stack = typeof errorLike.stack === 'string' ? errorLike.stack : undefined
            const messageField = typeof errorLike.message === 'string' ? errorLike.message : ''
            const message = messageField || (JSON.stringify(msg) ?? String(msg))
            return { message, stack }
        }
        return { message: JSON.stringify(msg) ?? String(msg) }
    } catch {
        return { message: String(msg) }
    }
}

export function alertError(msg: unknown) {
    // Avoid logging the same error through both console capture and addLog.
    nativeConsoleError(`[${PRODUCT_NAME} v${pocketKeiVer}]`, msg)
    let { message: errorMessage, stack: stackTrace } = normalizeErrorMessage(msg)
    errorMessage = errorMessage.trim()
    if (!errorMessage) {
        errorMessage = 'Unknown error'
    }

    if(errorMessage === '{}'){
        return
    }

    let submsg = ''

    if(errorMessage.includes('Failed to fetch') || errorMessage.includes("NetworkError when attempting to fetch resource.")){
        submsg = language.errors.networkFetch
    }

    addLog({
        level: 'error',
        message: errorMessage,
        description: stackTrace,
        source: 'blocking-alert',
    })

    alertStoreImported.set({
        'type': 'error',
        'msg': errorMessage,
        'submsg': submsg,
        'stackTrace': stackTrace
    })
}

export async function waitAlert(){
    while(true){
        if (get(alertStoreImported).type === 'none'){
            break
        }
        await sleep(10)
    }
}

export function alertNormal(msg:string){
    alertStoreImported.set({
        'type': 'normal',
        'msg': msg
    })
}

export async function alertNormalWait(msg:string){
    alertNormal(msg)
    await waitAlert()
}

export async function alertAddCharacter() {
    alertStoreImported.set({
        'type': 'addchar',
        'msg': language.addCharacter
    })
    await waitAlert()

    return get(alertStoreImported).msg
}

/** Returns the selected option index as a string, or "-1" when dismissed. */
export async function alertSelect(msg:string[], options?:string|AlertSelectOptions){
    const display = typeof options === 'string' ? options : options?.display
    const closeOnOutsideClick = typeof options === 'string'
        ? true
        : options?.closeOnOutsideClick ?? true
    const message = display !== undefined ? `__DISPLAY__${display}||${msg.join('||')}` : msg.join('||')
    alertStoreImported.set({
        'type': 'select',
        'msg': message,
        closeOnOutsideClick,
    })

    await waitAlert()

    return get(alertStoreImported).msg
}

export function alertMd(msg:string, options: { closeOnly?: boolean } = {}){
    alertStoreImported.set({
        'type': 'markdown',
        'msg': msg,
        hideConfirm: options.closeOnly,
    })
}

export function doingAlert(){
    return get(confirmationState).length > 0 ||
        (get(alertStoreImported).type !== 'none' && get(alertStoreImported).type !== 'wait')
}

// Finish progress feedback without dismissing dialogs awaiting user input.
function clearTransitionalAlert() {
    const current = get(alertStoreImported).type
    if (current === 'wait' || current === 'progress') {
        alertStoreImported.set({ type: 'none', msg: '' })
    }
}

export function notifyError(msg: unknown, opts?: NotifyOptions) {
    clearTransitionalAlert()
    const { message, stack } = normalizeErrorMessage(msg)
    const description = opts?.description ?? stack
    if (opts?.log !== false) {
        addLog({ level: 'error', message, description, source: opts?.source })
    }
    toast.error(message, description ? { description } : undefined)
}

export function notifyWarning(msg: unknown, opts?: NotifyOptions) {
    clearTransitionalAlert()
    const { message, stack } = normalizeErrorMessage(msg)
    const description = opts?.description ?? stack
    if (opts?.log !== false) {
        addLog({ level: 'warning', message, description, source: opts?.source })
    }
    toast.warning(message, description ? { description } : undefined)
}

export function notifyInfo(msg: unknown, opts?: NotifyOptions) {
    clearTransitionalAlert()
    const { message } = normalizeErrorMessage(msg)
    if (opts?.log !== false) {
        addLog({ level: 'info', message, description: opts?.description, source: opts?.source })
    }
    toast.info(message, opts?.description ? { description: opts.description } : undefined)
}

export function notifySuccess(msg: unknown, opts?: Pick<NotifyOptions, 'description'>) {
    clearTransitionalAlert()
    const { message } = normalizeErrorMessage(msg)
    toast.success(message, opts?.description ? { description: opts.description } : undefined)
}

export function alertWait(msg:string, title?:string){
    alertStoreImported.set({
        'type': 'wait',
        'msg': msg,
        title,
    })

}


export function alertClear(){
    alertStoreImported.set({
        'type': 'none',
        'msg': ''
    })
}

export async function alertConfirm(msg:string, description?:string){
    return await requestConfirmation({ kind: 'confirm', message: msg, description }) === true
}

export async function alertConfirmMulti(prompt:string, actions:(string | AlertAction)[], description?:string){
    const normalized: AlertAction[] = actions.map(a =>
        typeof a === 'string' ? { label: a, variant: 'default' } : a
    )
    const result = await requestConfirmation({ kind: 'multi', message: prompt, description, actions: normalized })
    return typeof result === 'number' ? result : -1
}

export async function alertCardExport(type:string = ''){

    alertStoreImported.set({
        'type': 'cardexport',
        'msg': '',
        'submsg': type
    })

    await waitAlert()

    const raw = get(alertStoreImported).msg
    if (!raw) {
        return { type: 'cancel', type2: '' }
    }

    try {
        const parsed = JSON.parse(raw) as { type?: unknown, type2?: unknown }
        if (typeof parsed.type === 'string' && typeof parsed.type2 === 'string') {
            return { type: parsed.type, type2: parsed.type2 }
        }
    } catch {
    }

    return { type: 'cancel', type2: '' }
}

export async function alertTOS(): Promise<boolean> {
    if (get(risuTosAccepted)) return true
    const accepted = await requestConfirmation({ kind: 'terms' }) === true
    if (accepted) {
        try {
            localStorage.setItem(RISU_TOS_STORAGE_KEY, RISU_TOS_REVISION)
        } catch {}
        risuTosAccepted.set(true)
    }
    return accepted
}

export async function alertInput(msg:string, datalist?:[string, string][], defaultValue?:string) {

    alertStoreImported.set({
        'type': 'input',
        'msg': msg,
        'datalist': datalist ?? [],
        'defaultValue': defaultValue ?? ''
    })

    await waitAlert()

    return get(alertStoreImported).msg
}

export async function alertModuleSelect(){

    alertStoreImported.set({
        'type': 'selectModule',
        'msg': ''
    })

    await waitAlert()

    return get(alertStoreImported).msg
}

export function alertRequestData(info:AlertGenerationInfoStoreData){
    alertGenerationInfoStore.set(info)
    alertStoreImported.set({
        'type': 'requestdata',
        'msg': info.genInfo.generationId ?? 'none'
    })
}

export async function alertTogglePresets(): Promise<void> {
    return new Promise<void>(resolve => {
        togglePresetsOpenStore.set(true)
        const unsub = togglePresetsOpenStore.subscribe(v => {
            if (!v) {
                unsub()
                resolve()
            }
        })
    })
}
