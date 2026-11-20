import { language } from 'src/lang'
import { notifyError, notifySuccess } from '../alert'
import { forageStorage } from '../storage/autoStorage'
import { DBState } from '../stores.svelte'
import { isPrivacyGuardActive } from '../platform'
import type { KeiClipboardCatalog, KeiClipboardEntry } from './keiClipboardTypes'
import { focusedEditableField, textInputOf } from '../gui/editableField'

/**
 * In-app copies skip the OS clipboard so role-play text cannot be pasted into another
 * app by accident. Pasting in is no leak, so Ctrl+V still yields to an OS clipboard
 * that changed after the newest Kei clipboard entry.
 */

export const keiClipboard = $state({ entries: [] as KeiClipboardEntry[] })

export const keiClipboardPicker = $state({ open: false })

interface PasteTarget {
    element: HTMLElement
    selectionStart: number | null
    selectionEnd: number | null
}

let pickerTarget: PasteTarget | null = null
let requestQueue: Promise<unknown> = Promise.resolve()
let queuedRefresh: Promise<void> | null = null
let localSequence = 0
// Copies whose POST has not settled. A catalog fetched before the server stored them
// must not undo them, or Ctrl+V would paste the previous entry meanwhile.
const pendingCopies = new Set<string>()
// An OS clipboard change can only come from another app, so it happened after the
// user last left this page; that, not when a paste first notices it, orders it
// against Kei clipboard copies.
let lastLeftPageAt = Date.now()
let nativeClipboardPassthrough = false

const TOP_SEEN_KEY = 'pocketrisu:kei-clipboard-top'
const EXTERNAL_SEEN_KEY = 'pocketrisu:kei-clipboard-external'

export function keiClipboardEnabled(): boolean {
    return DBState.db?.keiClipboard !== false
}

/**
 * The privacy guard is for showing the app to others, so it turns the Kei clipboard on.
 * The user's own value is kept in the database so any device can restore it, and only
 * the first one is kept so a retried enable cannot overwrite it with the forced value.
 */
export function enableKeiClipboardForPrivacyGuard() {
    DBState.db.keiClipboardBeforePrivacyGuard ??= DBState.db.keiClipboard !== false
    DBState.db.keiClipboard = true
}

/**
 * Runs when enabling fails, and at startup once the guard is off rather than on disable:
 * that save would happen before the password is checked or, after the switch, from the
 * guarded projection.
 */
export function restoreKeiClipboardAfterPrivacyGuard(): boolean {
    const previous = DBState.db.keiClipboardBeforePrivacyGuard
    if (previous === undefined) return false
    DBState.db.keiClipboard = previous
    delete DBState.db.keiClipboardBeforePrivacyGuard
    return true
}

// Only a fingerprint of OS clipboard text is kept, never the text itself.
function fingerprint(text: string): string {
    let hash = 0x811c9dc5
    for (let i = 0; i < text.length; i++) {
        hash ^= text.charCodeAt(i)
        hash = Math.imul(hash, 0x01000193)
    }
    return `${text.length}:${(hash >>> 0).toString(36)}`
}

interface SeenMark { hash: string, at: number }

function readSeen(key: string): SeenMark | null {
    try {
        const parsed = JSON.parse(localStorage.getItem(key) ?? 'null')
        return typeof parsed?.hash === 'string' && typeof parsed?.at === 'number' ? parsed : null
    } catch {
        return null
    }
}

function writeSeen(key: string, mark: SeenMark) {
    try {
        localStorage.setItem(key, JSON.stringify(mark))
    } catch {
        // Storage can be unavailable in private or restricted browser contexts.
    }
}

/**
 * Keyed by text so the server acknowledging a copy made here keeps the copy's own time;
 * `copiedNow` makes a re-copy of the same text count as new.
 */
function noteTopEntry(copiedNow = false) {
    const top = keiClipboard.entries[0]
    if (!top) return
    const hash = fingerprint(top.text)
    if (copiedNow || readSeen(TOP_SEEN_KEY)?.hash !== hash) writeSeen(TOP_SEEN_KEY, { hash, at: Date.now() })
}

/** An explicit OS copy from this page is newer than anything already in the Kei clipboard. */
function noteSystemClipboardWrite(text: string) {
    writeSeen(EXTERNAL_SEEN_KEY, { hash: fingerprint(text), at: Date.now() })
}

function noteExternalText(text: string): SeenMark | null {
    if (!text) return null
    const hash = fingerprint(text)
    const previous = readSeen(EXTERNAL_SEEN_KEY)
    if (previous?.hash === hash) return previous
    const mark = { hash, at: lastLeftPageAt }
    writeSeen(EXTERNAL_SEEN_KEY, mark)
    return mark
}

function installCatalog(catalog: KeiClipboardCatalog) {
    // Copies still in flight stay on top, even when an older catalog already holds the
    // same text further down.
    const copying = keiClipboard.entries.filter(entry => pendingCopies.has(entry.text))
    keiClipboard.entries = [...copying, ...catalog.entries.filter(entry => !pendingCopies.has(entry.text))]
    noteTopEntry()
}

// Requests run one at a time, so a refresh can never overtake an earlier write.
function enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const run = requestQueue.then(operation)
    requestQueue = run.catch(() => {})
    return run
}

function mutate(operation: () => Promise<KeiClipboardCatalog>) {
    void enqueue(async () => installCatalog(await operation())).catch(reportFailure)
}

function reportFailure(error: unknown) {
    console.error('[kei-clipboard] Request failed', error)
    notifyError(language.keiClipboardSyncFailed, { description: String(error) })
}

export function refreshKeiClipboard(): Promise<void> {
    queuedRefresh ??= enqueue(async () => {
        queuedRefresh = null
        installCatalog(await forageStorage.realStorage.fetchKeiClipboard())
    })
    return queuedRefresh
}

export function addKeiClipboardText(text: string) {
    if (!text) return
    const existing = keiClipboard.entries.find(entry => entry.text === text)
    keiClipboard.entries = [
        { id: `local-${++localSequence}`, text, createdAt: Date.now(), pinned: existing?.pinned ?? false },
        ...keiClipboard.entries.filter(entry => entry.text !== text),
    ]
    noteTopEntry(true)
    pendingCopies.add(text)
    const copiedUnderGuard = isPrivacyGuardActive
    void enqueue(async () => {
        let catalog: KeiClipboardCatalog
        try {
            catalog = await forageStorage.realStorage.addKeiClipboardEntry(text, copiedUnderGuard)
        } finally {
            pendingCopies.delete(text)
        }
        installCatalog(catalog)
    }).catch(reportFailure)
}

export function pinKeiClipboardEntry(entry: KeiClipboardEntry, pinned: boolean) {
    mutate(() => forageStorage.realStorage.pinKeiClipboardEntry(entry.id, pinned))
}

export function removeKeiClipboardEntry(entry: KeiClipboardEntry) {
    keiClipboard.entries = keiClipboard.entries.filter(item => item.id !== entry.id)
    mutate(() => forageStorage.realStorage.deleteKeiClipboardEntry(entry.id))
}

export function clearKeiClipboard() {
    keiClipboard.entries = keiClipboard.entries.filter(entry => entry.pinned)
    mutate(() => forageStorage.realStorage.deleteKeiClipboardEntry())
}

function selectedText(): string {
    const input = textInputOf(document.activeElement)
    if (input) {
        const { selectionStart: start, selectionEnd: end } = input
        return start !== null && end !== null && end > start ? input.value.slice(start, end) : ''
    }
    return window.getSelection()?.toString() ?? ''
}

function insertText(target: HTMLElement, text: string) {
    target.focus({ preventScroll: true })
    // execCommand keeps the native undo stack and fires the input events bindings listen to.
    if (document.execCommand('insertText', false, text)) return
    const input = textInputOf(target)
    if (!input) return
    const start = input.selectionStart ?? input.value.length
    input.setRangeText(text, start, input.selectionEnd ?? start, 'end')
    input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertFromPaste', data: text }))
}

/**
 * Rich editors (CodeMirror) get the text as a paste event so their own paste rules
 * apply, such as pasting a line-wise copy as a whole line; plain fields and editors
 * that ignore it fall back to inserting the text.
 */
function pasteInto(target: HTMLElement, text: string) {
    if (!textInputOf(target)) {
        const clipboardData = new DataTransfer()
        clipboardData.setData('text/plain', text)
        const paste = new ClipboardEvent('paste', { clipboardData, bubbles: true, cancelable: true })
        if (!target.dispatchEvent(paste)) return
    }
    insertText(target, text)
}

/** The fallback covers plain HTTP, where the async Clipboard API is missing. */
export async function writeSystemClipboard(text: string): Promise<void> {
    try {
        if (navigator.clipboard?.writeText) {
            await navigator.clipboard.writeText(text)
            noteSystemClipboardWrite(text)
            return
        }
    } catch {}
    const textarea = document.createElement('textarea')
    textarea.value = text
    textarea.style.position = 'fixed'
    textarea.style.opacity = '0'
    const previousFocus = document.activeElement as HTMLElement | null
    document.body.appendChild(textarea)
    textarea.select()
    nativeClipboardPassthrough = true
    let copied: boolean
    try {
        copied = document.execCommand('copy')
    } finally {
        nativeClipboardPassthrough = false
        textarea.remove()
        previousFocus?.focus({ preventScroll: true })
    }
    if (!copied) throw new Error('The browser refused to copy to the OS clipboard.')
    noteSystemClipboardWrite(text)
}

/** Copy entry point for in-app buttons; text meant for other apps uses writeSystemClipboard. */
export async function copyText(text: string): Promise<void> {
    if (keiClipboardEnabled()) {
        addKeiClipboardText(text)
        return
    }
    await writeSystemClipboard(text)
}

/** The browser's own copy keeps the selection's formatting and works over plain HTTP. */
export function copySelectionToSystemClipboard(): boolean {
    const text = selectedText()
    if (!text) return false
    nativeClipboardPassthrough = true
    try {
        if (!document.execCommand('copy')) return false
    } finally {
        nativeClipboardPassthrough = false
    }
    noteSystemClipboardWrite(text)
    notifySuccess(language.copiedToSystemClipboard)
    return true
}

/** Buttons pass their field explicitly, since clicking them has already moved focus. */
export function openKeiClipboardPicker(element: HTMLElement | null = focusedEditableField()): boolean {
    if (!keiClipboardEnabled()) return false
    // Reopening would retarget the paste at the picker's own search field.
    if (keiClipboardPicker.open) return true
    const input = textInputOf(element)
    pickerTarget = element && {
        element,
        selectionStart: input?.selectionStart ?? null,
        selectionEnd: input?.selectionEnd ?? null,
    }
    keiClipboardPicker.open = true
    void refreshKeiClipboard().catch(reportFailure)
    return true
}

export function applyKeiClipboardChoice(entry: KeiClipboardEntry | null) {
    const target = pickerTarget
    pickerTarget = null
    if (!target?.element.isConnected) return
    target.element.focus({ preventScroll: true })
    const input = textInputOf(target.element)
    if (input && target.selectionStart !== null) {
        input.setSelectionRange(target.selectionStart, target.selectionEnd ?? target.selectionStart)
    }
    if (entry) pasteInto(target.element, entry.text)
}

function handleCopy(event: ClipboardEvent) {
    if (nativeClipboardPassthrough || !keiClipboardEnabled() || !event.clipboardData) return
    let text: string
    if (event.defaultPrevented) {
        // An editor already filled the transfer itself; take its text back off the OS path.
        text = event.clipboardData.getData('text/plain')
        if (!text) return
        event.clipboardData.clearData()
    } else {
        text = selectedText()
        if (!text) return
        event.preventDefault()
        if (event.type === 'cut' && focusedEditableField()) document.execCommand('delete')
    }
    addKeiClipboardText(text)
}

function handlePaste(event: ClipboardEvent) {
    // Our own re-dispatched paste for rich editors must reach them untouched.
    if (!event.isTrusted) return
    if (!keiClipboardEnabled()) return
    const data = event.clipboardData
    const external = noteExternalText(data?.getData('text/plain') ?? '')
    if (data && Array.from(data.items).some(item => item.kind === 'file')) return
    const top = keiClipboard.entries[0]
    if (!top) return
    if (external && external.at > (readSeen(TOP_SEEN_KEY)?.at ?? 0)) return
    const target = focusedEditableField()
    if (!target) return
    event.preventDefault()
    event.stopImmediatePropagation()
    pasteInto(target, top.text)
}

function notePageLeft() {
    if (document.visibilityState === 'hidden' || !document.hasFocus()) lastLeftPageAt = Date.now()
}

export function installKeiClipboard(): () => void {
    window.addEventListener('blur', notePageLeft)
    document.addEventListener('visibilitychange', notePageLeft)
    window.addEventListener('copy', handleCopy)
    window.addEventListener('cut', handleCopy)
    window.addEventListener('paste', handlePaste, true)
    return () => {
        window.removeEventListener('blur', notePageLeft)
        document.removeEventListener('visibilitychange', notePageLeft)
        window.removeEventListener('copy', handleCopy)
        window.removeEventListener('cut', handleCopy)
        window.removeEventListener('paste', handlePaste, true)
    }
}
