import { Buffer } from 'buffer'
import { validateContentReferences, type ContentReferenceKind } from '../../../shared/contentReferences.mjs'
// ── NodeOnly: server-side JWT ────────────────────────────────────────────────
// Upstream uses client-side ECDSA JWT (crypto.subtle) which requires Secure
// Context (HTTPS/localhost). NodeOnly needs HTTP remote access, so JWT
// signing is moved to the server. The client only caches and forwards
// server-issued tokens. If upstream changes its auth flow, sync manually.
// Server counterpart: server/node/server.cjs (createServerJwt, checkAuth,
// /api/login, /api/token/refresh)
import { language } from "src/lang"
import { alertInput, waitAlert, notifyError } from "../alert"
import { decodeRisuSave, encodeRisuSaveLegacy } from "./risuSave"
import { normalizeChat } from "./database.svelte"
import { CHAT_CONTENT_READ_POLICY, storageRequestError, StorageRequestError } from './storageRequest'
import { fetchWithRequestTimeout } from '../../../shared/requestTimeout.mjs'
import { isPatchHashDiagnostics, type PatchHashDiagnostics } from '../../../shared/patchHashDiagnostics.mjs'
import type {
    BookmarkCatalog,
    BookmarkCompatibilityResult,
    BookmarkTarget,
} from '../bookmarks/bookmarkTypes'

const BOOKMARKS_API_PATH = '/api/bookmarks'
const BOOKMARK_TAGS_API_PATH = '/api/bookmark-tags'

function serverErrorMessage(body: any, fallback: string): string {
    switch (body?.code) {
        case 'BACKUP_ENCRYPTION_METADATA_INVALID': return language.errors.backupEncryptionMetadataInvalid
        case 'BACKUP_ENCRYPTION_KEY_UNAVAILABLE': return language.errors.backupEncryptionKeyUnavailable
        case 'BACKUP_DECRYPTION_FAILED': return language.errors.backupDecryptionFailed
        case 'UNSUPPORTED_REMOTE_SAVE': return language.unsupportedRemoteSave
    }
    return typeof body?.error === 'string' ? body.error
        : typeof body?.message === 'string' ? body.message : fallback
}

// Custom error class for database conflict detection
export class ConflictError extends Error {
    currentEtag: string
    constructor(message: string, currentEtag: string) {
        super(message)
        this.name = 'ConflictError'
        this.currentEtag = currentEtag
    }
}

// Warning the server attaches to /api/patch responses when the most recent
// debounced persist failed (Stage 1 visibility — see issues.md).
export interface PersistWarning {
    timestamp: number
    message: string
    attemptedSize: number | null
    source: string
}

export interface PatchItemResult {
    conflictCode?: string
    currentHash?: string
    hashDiagnostics?: PatchHashDiagnostics
    success: boolean
    etag?: string
    revision?: number
    conflict?: boolean
    persistWarning?: PersistWarning
    /** Set when the server's chat-internal-field guard rejected the patch. */
    chatGuardRejected?: boolean
}

export interface DatabaseProjection<T = unknown> {
    database: T | null
    etag: string
    revision: number
}

export interface PluginStorageStartupStats {
    totalBytes: number
    unclassifiedBytes: number
    plugins: Array<{
        name: string
        displayName: string
        bytes: number
    }>
}

export interface PluginStorageExclusion {
    all?: boolean
    pluginNames?: string[]
    unclassified?: boolean
}

export interface ExportBackupOptions {
    target?: 'upstream'
    mode?: 'settings'
    moduleAssets?: boolean
}

export interface SettingsBackupEstimate {
    dbBytes: number
    baseAssets: { count: number, bytes: number }
    moduleAssets: { count: number, bytes: number, moduleCount: number }
}

/** Page-scoped id used for sync self-echo suppression and request tracing. */
export function getSyncClientId(): string {
    return NodeStorage.getSessionId()
}

export class NodeStorage{
    private static readonly BULK_WRITE_CLIENT_BATCH = 20

    // Unique per page load — identifies the origin of writes and sync events.
    private static sessionId: string =
        crypto?.randomUUID?.() ?? (Date.now().toString(36) + Math.random().toString(36).slice(2))

    _lastDbEtag: string | null = null
    _lastDbRevision: number | null = null
    private chatEtags = new Map<string, string>()
    authChecked = false
    private cachedJwt: { token: string; expiresAt: number } | null = null
    private static sessionInitialized = false
    private static sessionPending: Promise<void> | null = null
    private refreshPending: Promise<string> | null = null
    private authPending: Promise<void> | null = null
    private pluginStorageExclusionHeader = ''

    static getSessionId() {
        return NodeStorage.sessionId
    }

    async createAuth(): Promise<string> {
        const now = Date.now()
        if (this.cachedJwt && this.cachedJwt.expiresAt - now > 30_000) {
            return this.cachedJwt.token
        }

        // A fresh page has no in-memory JWT. Authenticate first instead of
        // calling /api/token/refresh with an empty risu-auth header.
        if (!this.cachedJwt) {
            await this.checkAuth()
            if (!this.cachedJwt) {
                throw new Error('Node auth unavailable')
            }
            return this.cachedJwt.token
        }

        const token = await this._refreshToken()
        if (token) return token

        // A rejected refresh means the cached token is no longer usable.
        // Re-establish authentication through /api/test_auth instead of
        // returning an empty or stale token to the caller.
        this.cachedJwt = null
        this.authChecked = false
        await this.checkAuth()
        if (!this.cachedJwt) {
            throw new Error('Node auth unavailable')
        }
        return this.cachedJwt.token
    }

    // Called once after JWT auth is confirmed. Issues a session cookie so that
    // <img src="/api/asset/..."> can be served without JS-injected headers.
    private async initSession(authToken: string) {
        if (NodeStorage.sessionInitialized) return
        if (NodeStorage.sessionPending) return NodeStorage.sessionPending
        NodeStorage.sessionPending = this._doInitSession(authToken)
        return NodeStorage.sessionPending
    }

    private async _doInitSession(authToken: string) {
        try {
            const res = await fetch('/api/session', {
                method: 'POST',
                headers: {
                    'risu-auth': authToken,
                    'x-sync-client-id': NodeStorage.sessionId,
                },
            })
            if (res.ok) {
                NodeStorage.sessionInitialized = true
            }
            // Non-ok (400/401/500): will retry on next checkAuth() call.
        } catch {
            // Network error: will retry on next checkAuth() call.
        } finally {
            NodeStorage.sessionPending = null
        }
    }

    private async _refreshToken(): Promise<string> {
        if (this.refreshPending) return this.refreshPending
        this.refreshPending = this._doRefreshToken()
        try { return await this.refreshPending }
        finally { this.refreshPending = null }
    }

    private async _doRefreshToken(): Promise<string> {
        const res = await fetch('/api/token/refresh', {
            method: 'POST',
            headers: { 'risu-auth': this.cachedJwt?.token ?? '' }
        })
        if (res.ok) {
            const data = await res.json()
            this.cachedJwt = { token: data.token, expiresAt: Date.now() + 5 * 60 * 1000 }
            return data.token
        }
        return ''
    }

    private async loginWithPassword(password: string) {
        const response = await fetch('/api/login', {
            method: "POST",
            body: JSON.stringify({ password }),
            headers: {
                'content-type': 'application/json'
            }
        })

        if(response.status === 429){
            notifyError(`Too many attempts. Please wait and try again later.`)
            await waitAlert()
            throw new Error('Too many login attempts')
        }

        if(response.status < 200 || response.status >= 300){
            let message = 'Node login failed'
            try {
                const data = await response.json()
                message = data.error ?? message
            } catch {
                // noop
            }
            throw new Error(message)
        }

        const data = await response.json()
        if (data.token) {
            this.cachedJwt = { token: data.token, expiresAt: Date.now() + 5 * 60 * 1000 }
        }
        this.authChecked = true
    }

    private async shouldRetryAuth(response: Response) {
        if(response.status !== 400 && response.status !== 401){
            return false
        }

        try {
            const data = await response.clone().json()
            return [
                'Invalid Signature',
                'Token Expired'
            ].includes(data?.error)
        } catch {
            return false
        }
    }

    private async authFetch(input: RequestInfo | URL, init: RequestInit = {}, policy: {
        retryAuth?: boolean
        firstResponseTimeoutMs?: number
    } = {}): Promise<Response> {
        const request = async (signal: AbortSignal | null | undefined) => {
            await this.checkAuth()
            const headers = new Headers(init.headers)
            headers.set('risu-auth', await this.createAuth())
            headers.set('x-sync-client-id', NodeStorage.sessionId)
            // A timed-out auth preflight must not dispatch a late chat GET.
            signal?.throwIfAborted()
            const response = await fetch(input, { ...init, headers, signal })
            if (policy.retryAuth !== false && await this.shouldRetryAuth(response)) {
                this.authChecked = false
                this.cachedJwt = null
                return this.authFetch(input, { ...init, signal }, { retryAuth: false })
            }
            return response
        }
        if (!policy.firstResponseTimeoutMs) return request(init.signal)
        return fetchWithRequestTimeout(request, {
            signal: init.signal,
            firstResponseTimeoutMs: policy.firstResponseTimeoutMs,
        })
    }

    async setItem(key:string, value:Uint8Array, etag?:string) {
        const headers: Record<string, string> = {
            'content-type': 'application/octet-stream',
            'file-path': Buffer.from(key, 'utf-8').toString('hex')
        }
        if (etag) {
            headers['x-if-match'] = etag
        }
        const da = await this.authFetch('/api/write', {
            method: "POST",
            body: value as any,
            headers
        })
        if(da.status === 409){
            const data = await da.json()
            throw new ConflictError(data.error, data.currentEtag)
        }
        if(da.status < 200 || da.status >= 300){
            throw await storageRequestError('setItem', da)
        }
        const data = await da.json()
        if(data.error){
            throw new StorageRequestError('setItem', da.status, String(data.error))
        }
        const nextEtag = data.etag as string | undefined
        if (key === 'database/database.bin' && nextEtag) {
            this._lastDbEtag = nextEtag
        }
    }

    async encodeInlayWebp(value: Uint8Array, options: { lossy: boolean; quality: number }): Promise<Blob> {
        const response = await this.authFetch('/api/inlays/encode-webp', {
            method: 'POST',
            body: value as any,
            headers: {
                'content-type': 'application/octet-stream',
                'x-inlay-lossy': options.lossy ? '1' : '0',
                'x-inlay-quality': String(options.quality),
            },
        })
        if (!response.ok) {
            throw await storageRequestError('encodeInlayWebp', response)
        }
        return new Blob([await response.arrayBuffer()], { type: 'image/webp' })
    }

    async getItem(key:string):Promise<Buffer> {
        const headers: Record<string, string> = {
            'file-path': Buffer.from(key, 'utf-8').toString('hex')
        }

        const da = await this.authFetch('/api/read', { method: "GET", headers })
        if(da.status < 200 || da.status >= 300){
            throw await storageRequestError('getItem', da)
        }

        // Capture ETag for database.bin
        const etag = da.headers.get('x-db-etag')
        if (etag) {
            this._lastDbEtag = etag
        }

        const data = Buffer.from(await da.arrayBuffer())
        if (data.length === 0){
            return null
        }

        return data
    }
    async keyPage(prefix: string = '', options?: { order?: 'updated-desc'; limit?: number; offset?: number }):Promise<{ keys: string[]; total: number }>{
        const headers: Record<string, string> = {
        }
        if (prefix) {
            headers['key-prefix'] = prefix
        }
        if (options?.order === 'updated-desc') {
            headers['key-order'] = options.order
        }
        if (options?.limit && Number.isSafeInteger(options.limit) && options.limit > 0) {
            headers['key-limit'] = String(options.limit)
        }
        if (options?.offset && Number.isSafeInteger(options.offset) && options.offset > 0) {
            headers['key-offset'] = String(options.offset)
        }
        const da = await this.authFetch('/api/list', {
            method: "GET",
            headers
        })
        if(da.status < 200 || da.status >= 300){
            throw await storageRequestError('listItem', da)
        }
        const data = await da.json()
        if(data.error){
            throw data.error
        }
        return {
            keys: data.content,
            total: Number(data.total) || data.content.length,
        }
    }
    async keys(prefix: string = '', options?: { order?: 'updated-desc'; limit?: number; offset?: number }):Promise<string[]>{
        return (await this.keyPage(prefix, options)).keys
    }
    async removeItem(key:string){
        const da = await this.authFetch('/api/remove', {
            method: "GET",
            headers: {
                'file-path': Buffer.from(key, 'utf-8').toString('hex')
            }
        })
        if(da.status < 200 || da.status >= 300){
            throw await storageRequestError('removeItem', da)
        }
        const data = await da.json()
        if(data.error){
            throw data.error
        }
    }

    private async checkAuth() {
        if (this.authChecked && this.cachedJwt) {
            await this.initSession(this.cachedJwt.token)
            return
        }
        if (this.authPending) return this.authPending

        this.authPending = this._doCheckAuth()
        try {
            await this.authPending
        } finally {
            this.authPending = null
        }
    }

    private async _doCheckAuth() {
        if(!this.authChecked){
            const data = await (await fetch('/api/test_auth',{
                headers: {
                    'risu-auth': this.cachedJwt?.token ?? ''
                }
            })).json()

            if(data.status === 'unset'){
                const input = await digestPassword(await alertInput(language.setNodePassword))
                const response = await fetch('/api/set_password',{
                    method: "POST",
                    body:JSON.stringify({
                        password: input 
                    }),
                    headers: {
                        'content-type': 'application/json'
                    }
                })

                if(response.status < 200 || response.status >= 300){
                    throw new Error('Failed to set node password')
                }

                await this.loginWithPassword(input)
                if (!this.cachedJwt) throw new Error('Node auth unavailable')
                await this.initSession(this.cachedJwt.token)
                return
            }
            else if(data.status === 'incorrect'){
                const input = await digestPassword(await alertInput(language.inputNodePassword))
                await this.loginWithPassword(input)
                if (!this.cachedJwt) throw new Error('Node auth unavailable')
                await this.initSession(this.cachedJwt.token)
                return
            }
            else{
                if (data.token) {
                    this.cachedJwt = { token: data.token, expiresAt: Date.now() + 5 * 60 * 1000 }
                }
                this.authChecked = true
            }
        }
        if (!this.cachedJwt) throw new Error('Node auth unavailable')
        await this.initSession(this.cachedJwt.token)
    }

    listItem = this.keys

    /** Set cached ETag for database.bin */
    setDbEtag(etag: string | null) {
        this._lastDbEtag = etag
    }

    /** Set the revision associated with the cached database projection. */
    setDbRevision(revision: number | null) {
        this._lastDbRevision = revision
    }

    setPluginStorageExclusion(exclusion: PluginStorageExclusion | null) {
        if (!exclusion) {
            this.pluginStorageExclusionHeader = ''
            return
        }
        if (exclusion.all) {
            this.pluginStorageExclusionHeader = 'all'
            return
        }
        const pluginNames = [...new Set(exclusion.pluginNames ?? [])]
        if (pluginNames.length === 0 && !exclusion.unclassified) {
            this.pluginStorageExclusionHeader = ''
            return
        }
        this.pluginStorageExclusionHeader = Buffer.from(JSON.stringify({
            plugins: pluginNames,
            unclassified: exclusion.unclassified === true,
        }), 'utf8').toString('base64')
    }

    async getPluginStorageStartupStats(): Promise<PluginStorageStartupStats> {
        const response = await this.authFetch('/api/plugin-storage/startup-stats', {
            method: 'GET',
            headers: { accept: 'application/json' },
        })
        if (!response.ok) {
            throw new Error(`Plugin storage startup stats failed (${response.status})`)
        }
        return await response.json() as PluginStorageStartupStats
    }

    /** Read cleanup references without replacing the autosave revision/ETag. */
    async scanContentReferences(kind: ContentReferenceKind, candidates: string[]) {
        const response = await this.authFetch('/api/database/content-references', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ kind, candidates }),
            cache: 'no-store',
        })
        if (!response.ok) throw await storageRequestError('scanContentReferences', response)
        return validateContentReferences(await response.json(), kind, candidates)
    }

    /** Load the relational database's client projection as JSON. */
    async getDatabaseProjection<T = unknown>(): Promise<DatabaseProjection<T>> {
        const headers:Record<string, string> = { accept: 'application/json' }
        if (this.pluginStorageExclusionHeader) {
            headers['x-risu-plugin-storage-exclusion'] = this.pluginStorageExclusionHeader
        }
        const response = await this.authFetch('/api/database', {
            method: 'GET',
            headers,
        })
        if (!response.ok) {
            throw await storageRequestError('getDatabaseProjection', response)
        }

        const data = await response.json() as DatabaseProjection<T>
        this._lastDbEtag = data.etag ?? null
        this._lastDbRevision = Number.isSafeInteger(data.revision) ? data.revision : null
        return data
    }

    /**
     * Initialize a brand-new relational database. The server only accepts this
     * while revision 0 is still current, so two first-run clients cannot replace
     * one another's initialized state.
     */
    async initializeDatabase<T>(database: T, expectedRevision = 0): Promise<PatchItemResult> {
        const response = await this.authFetch('/api/database', {
            method: 'PUT',
            body: JSON.stringify({ database, expectedRevision }),
            headers: { 'content-type': 'application/json' },
        })
        if (!response.ok && response.status !== 409) throw await storageRequestError('initializeDatabase', response)
        const data = await response.json().catch(() => ({})) as {
            error?: string
            etag?: string
            currentEtag?: string
            revision?: number
            currentRevision?: number
            persistWarning?: PersistWarning
        }
        const etag = data.etag ?? data.currentEtag
        const revision = data.revision ?? data.currentRevision
        if (etag) this._lastDbEtag = etag
        if (Number.isSafeInteger(revision)) this._lastDbRevision = revision as number

        if (response.status === 409) {
            return { success: false, conflict: true, etag, revision }
        }
        if (data.error) {
            throw new StorageRequestError('initializeDatabase', response.status, data.error)
        }
        return {
            success: true,
            etag,
            revision,
            persistWarning: data.persistWarning,
        }
    }

    /** Apply metadata changes to the relational database projection. */
    async patchDatabase(patchData: { patch: any[], expectedHash: string }): Promise<PatchItemResult> {
        return this.sendPatch('/api/database', patchData, true, undefined, 'PATCH')
    }

    async patchItem(key: string, patchData: { patch: any[], expectedHash: string }): Promise<PatchItemResult> {
        return this.sendPatch('/api/patch', patchData, key === 'database/database.bin', key)
    }

    private async sendPatch(
        endpoint: string,
        patchData: { patch: any[], expectedHash: string },
        tracksDatabase: boolean,
        key?: string,
        method: 'POST' | 'PATCH' = 'POST',
    ): Promise<PatchItemResult> {
        // An empty JSON Patch is the identity operation. It has no write intent,
        // so it must not enter the network/CAS lane with a potentially stale
        // hash while a server-owned generation commit is advancing the DB.
        if (patchData.patch.length === 0) return { success: true }
        const operation = tracksDatabase ? 'patchDatabase' : 'patchItem'

        const headers: Record<string, string> = {
            'content-type': 'application/json',
        }
        if (tracksDatabase && this.pluginStorageExclusionHeader) {
            headers['x-risu-plugin-storage-exclusion'] = this.pluginStorageExclusionHeader
        }
        if (key) {
            headers['file-path'] = Buffer.from(key, 'utf-8').toString('hex')
        }
        const da = await this.authFetch(endpoint, {
            method,
            body: JSON.stringify(patchData),
            headers,
        })

        if (da.status === 409) {
            const data = await da.json()
            const currentEtag = data.currentEtag as string | undefined
            const currentRevision = data.currentRevision as number | undefined
            if (tracksDatabase && currentEtag) {
                this._lastDbEtag = currentEtag
            }
            if (tracksDatabase && Number.isSafeInteger(currentRevision)) {
                this._lastDbRevision = currentRevision as number
            }
            // Server signals chat-guard rejection via explicit fields. The
            // error string fallback is kept for forward-compat with deployed
            // servers that haven't shipped the explicit fields yet.
            const rejectedByChatGuard = data.chatGuardRejected === true
                || data.code === 'CHAT_GUARD_REJECTED'
                || (typeof data.error === 'string' && data.error.includes('chat-internal field ops'))
            return {
                success: false,
                etag: currentEtag,
                revision: currentRevision,
                conflict: !rejectedByChatGuard,
                conflictCode: typeof data.code === 'string' ? data.code : undefined,
                currentHash: typeof data.currentHash === 'string' ? data.currentHash : undefined,
                hashDiagnostics: isPatchHashDiagnostics(data.hashDiagnostics) ? data.hashDiagnostics : undefined,
                chatGuardRejected: rejectedByChatGuard,
            }
        }
        if (da.status < 200 || da.status >= 300) {
            throw await storageRequestError(operation, da)
        }
        const data = await da.json()
        if (data.error) {
            throw new StorageRequestError(operation, da.status, String(data.error))
        }
        const nextEtag = data.etag as string | undefined
        const nextRevision = data.revision as number | undefined
        if (tracksDatabase && nextEtag) {
            this._lastDbEtag = nextEtag
        }
        if (tracksDatabase && Number.isSafeInteger(nextRevision)) {
            this._lastDbRevision = nextRevision as number
        }
        const persistWarning = data.persistWarning as PersistWarning | undefined
        return { success: true, etag: nextEtag, revision: nextRevision, persistWarning }
    }

    // ── Bulk asset operations (3-2-B) ──────────────────────────────────────────
    async getItems(keys: string[]): Promise<{key: string, value: Buffer}[]> {
        const da = await this.authFetch('/api/assets/bulk-read', {
            method: 'POST',
            body: JSON.stringify(keys),
            headers: {
                'content-type': 'application/json',
                'accept': 'application/octet-stream'
            }
        })
        if (da.status < 200 || da.status >= 300) throw await storageRequestError('getItems', da)

        const ct = da.headers.get('content-type') || ''
        if (ct.includes('application/octet-stream')) {
            // Binary protocol: [count(4)] then per entry: [keyLen(4)][key][valLen(4)][value]
            const buf = Buffer.from(await da.arrayBuffer())
            let offset = 0
            const count = buf.readUInt32BE(offset); offset += 4
            const results: {key: string, value: Buffer}[] = []
            for (let i = 0; i < count; i++) {
                const keyLen = buf.readUInt32BE(offset); offset += 4
                const key = buf.subarray(offset, offset + keyLen).toString('utf-8'); offset += keyLen
                const valLen = buf.readUInt32BE(offset); offset += 4
                const value = buf.subarray(offset, offset + valLen) as Buffer; offset += valLen
                results.push({ key, value })
            }
            return results
        }

        // Fallback: JSON+base64
        const results: {key: string, value: string}[] = await da.json()
        return results.map(r => ({ key: r.key, value: Buffer.from(r.value, 'base64') }))
    }

    async setItems(entries: {key: string, value: Uint8Array}[]) {
        for (let i = 0; i < entries.length; i += NodeStorage.BULK_WRITE_CLIENT_BATCH) {
            const batch = entries.slice(i, i + NodeStorage.BULK_WRITE_CLIENT_BATCH)
            const body = batch.map(e => ({
                key: e.key,
                value: Buffer.from(e.value).toString('base64')
            }))
            const da = await this.authFetch('/api/assets/bulk-write', {
                method: 'POST',
                body: JSON.stringify(body),
                headers: {
                    'content-type': 'application/json'
                }
            })
            if (da.status < 200 || da.status >= 300) throw await storageRequestError('setItems', da)
        }
    }

    async exportBackup(opts?: ExportBackupOptions): Promise<Response> {
        const params = new URLSearchParams()
        if(opts?.target === 'upstream') params.set('target', 'upstream')
        if(opts?.mode === 'settings') params.set('mode', 'settings')
        if(opts?.moduleAssets === false) params.set('moduleAssets', '0')
        const query = params.toString()
        const url = query ? `/api/backup/export?${query}` : '/api/backup/export'
        const da = await this.authFetch(url)
        if (da.status < 200 || da.status >= 300) throw `backup export error: ${da.status}`
        return da
    }

    async settingsBackupEstimate(): Promise<SettingsBackupEstimate> {
        const response = await this.authFetch('/api/backup/export/settings-estimate')
        if(!response.ok) throw new Error(`settings estimate error: ${response.status}`)
        return await response.json()
    }

    async prepareImport(size: number): Promise<void> {
        const da = await this.authFetch('/api/backup/import/prepare', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ size }),
        })
        if (da.status === 409) throw new Error('Another import is already in progress')
        if (da.status === 413) throw new Error('Backup file is too large')
        if (da.status === 507) {
            const body = await da.json().catch(() => ({}))
            const avail = body.available != null ? ` (available: ${Math.round(body.available / 1024 / 1024)} MB)` : ''
            throw new Error(`Insufficient disk space${avail}`)
        }
        if (da.status < 200 || da.status >= 300) throw new Error(`backup prepare error: ${da.status}`)
    }

    async importBackup(
        file: Blob,
        onProgress?: (loaded: number, total: number) => void
    ): Promise<{ok: boolean, assetsRestored: number, coldStorageFailed?: number}> {
        await this.prepareImport(file.size)
        const authHeader = await this.createAuth()

        return await new Promise((resolve, reject) => {
            const xhr = new XMLHttpRequest()
            xhr.open('POST', '/api/backup/import')
            xhr.setRequestHeader('content-type', 'application/x-risu-backup')
            xhr.setRequestHeader('risu-auth', authHeader)
            xhr.setRequestHeader('x-sync-client-id', NodeStorage.sessionId)
            // Opt into NDJSON streaming so the server keeps the response socket
            // alive during long post-upload work — prevents reverse-proxy 502s.
            xhr.setRequestHeader('accept', 'application/x-ndjson')

            let uploadComplete = false
            xhr.upload.onprogress = (event) => {
                if (event.lengthComputable) {
                    onProgress?.(event.loaded, event.total)
                }
            }
            xhr.upload.onload = () => { uploadComplete = true }

            let parsedIndex = 0
            let leftover = ''
            let result: {ok: boolean, assetsRestored: number, coldStorageFailed?: number} | null = null
            let serverErrorMsg: string | null = null

            const drainNdjson = () => {
                const text = xhr.responseText
                if (text.length <= parsedIndex) return
                leftover += text.slice(parsedIndex)
                parsedIndex = text.length
                const lines = leftover.split('\n')
                leftover = lines.pop() ?? ''
                for (const line of lines) {
                    if (!line) continue
                    let msg: any
                    try { msg = JSON.parse(line) } catch { continue }
                    if (msg.type === 'progress' && uploadComplete) {
                        // After upload finishes, surface server-side processing
                        // progress through the same callback for UI continuity.
                        onProgress?.(msg.bytes, msg.totalBytes)
                    } else if (msg.type === 'done') {
                        result = msg
                    } else if (msg.type === 'error') {
                        serverErrorMsg = serverErrorMessage(msg, 'backup import failed')
                    }
                    // Ignore 'heartbeat' and unknown event types.
                }
            }

            xhr.onprogress = drainNdjson
            xhr.onerror = () => reject(new Error('backup import request failed'))
            xhr.onload = () => {
                if (xhr.status < 200 || xhr.status >= 300) {
                    let msg = `backup import error: ${xhr.status}`
                    try {
                        const body = JSON.parse(xhr.responseText)
                        msg = serverErrorMessage(body, msg)
                    } catch {}
                    reject(new Error(msg))
                    return
                }
                drainNdjson()
                if (serverErrorMsg) reject(new Error(serverErrorMsg))
                else if (result) resolve(result)
                else reject(new Error('backup import: no result received'))
            }

            xhr.send(file)
        })
    }

    // ── Server-side backup ─────────────────────────────────────────────────────

    async saveServerBackup(
        note = '',
        onProgress?: (current: number, total: number, bytes: number, totalBytes: number) => void
    ): Promise<{ok: boolean, filename: string, size: number}> {
        const da = await this.authFetch('/api/backup/server/save', {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                'x-sync-client-id': NodeStorage.sessionId,
            },
            body: JSON.stringify({ note }),
        })
        if (da.status < 200 || da.status >= 300) {
            const body = await da.json().catch(() => ({}))
            throw new Error(body.error || `server backup save error: ${da.status}`)
        }

        const reader = da.body!.getReader()
        const decoder = new TextDecoder()
        let buffer = ''
        let result: {ok: boolean, filename: string, size: number} | null = null

        while (true) {
            const { done, value } = await reader.read()
            if (done) break
            buffer += decoder.decode(value, { stream: true })
            const lines = buffer.split('\n')
            buffer = lines.pop()!
            for (const line of lines) {
                if (!line) continue
                const msg = JSON.parse(line)
                if (msg.type === 'progress') {
                    onProgress?.(msg.current, msg.total, msg.bytes, msg.totalBytes)
                } else if (msg.type === 'done') {
                    result = msg
                } else if (msg.type === 'error') {
                    throw new Error(msg.message)
                }
            }
        }
        if (!result) throw new Error('Server backup: no result received')
        return result
    }

    async listServerBackups(): Promise<{backups: Array<{filename: string, size: number, createdAt: number, note?: string}>}> {
        const da = await this.authFetch('/api/backup/server/list')
        if (da.status < 200 || da.status >= 300) throw new Error(`server backup list error: ${da.status}`)
        return da.json()
    }

    async restoreServerBackup(
        filename: string,
        onProgress?: (bytes: number, totalBytes: number) => void
    ): Promise<{ok: boolean, assetsRestored: number, coldStorageFailed?: number}> {
        const da = await this.authFetch('/api/backup/server/restore', {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                'x-sync-client-id': NodeStorage.sessionId,
            },
            body: JSON.stringify({ filename }),
        })
        if (da.status === 404) throw new Error('Backup file not found')
        if (da.status === 409) throw new Error('Another import is already in progress')
        if (da.status < 200 || da.status >= 300) {
            const body = await da.json().catch(() => ({}))
            throw new Error(serverErrorMessage(body, `server backup restore error: ${da.status}`))
        }

        const reader = da.body!.getReader()
        const decoder = new TextDecoder()
        let buffer = ''
        let result: {ok: boolean, assetsRestored: number, coldStorageFailed?: number} | null = null

        while (true) {
            const { done, value } = await reader.read()
            if (done) break
            buffer += decoder.decode(value, { stream: true })
            const lines = buffer.split('\n')
            buffer = lines.pop()!
            for (const line of lines) {
                if (!line) continue
                const msg = JSON.parse(line)
                if (msg.type === 'progress') {
                    onProgress?.(msg.bytes, msg.totalBytes)
                } else if (msg.type === 'done') {
                    result = msg
                } else if (msg.type === 'error') {
                    throw new Error(serverErrorMessage(msg, 'Server backup restore failed'))
                }
            }
        }
        if (!result) throw new Error('Server backup restore: no result received')
        return result
    }

    async restoreMissingServerBackupAssets(
        filename: string,
        onProgress?: (bytes: number, totalBytes: number) => void
    ): Promise<{
        ok: boolean
        referencedAssets: number
        missingAssets: number
        assetsFound: number
        assetsUnavailable: number
        assetsRestored: number
        restoredBytes: number
        skippedExisting: number
    }> {
        const da = await this.authFetch('/api/backup/server/restore-assets', {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                'x-sync-client-id': NodeStorage.sessionId,
            },
            body: JSON.stringify({ filename }),
        })
        if (da.status === 404) throw new Error('Backup file not found')
        if (da.status === 409) throw new Error('Another import is already in progress')
        if (da.status < 200 || da.status >= 300) {
            const body = await da.json().catch(() => ({}))
            throw new Error(body.error || `server backup asset restore error: ${da.status}`)
        }

        const reader = da.body!.getReader()
        const decoder = new TextDecoder()
        let buffer = ''
        let result: {
            ok: boolean
            referencedAssets: number
            missingAssets: number
            assetsFound: number
            assetsUnavailable: number
            assetsRestored: number
            restoredBytes: number
            skippedExisting: number
        } | null = null

        while (true) {
            const { done, value } = await reader.read()
            if (done) break
            buffer += decoder.decode(value, { stream: true })
            const lines = buffer.split('\n')
            buffer = lines.pop()!
            for (const line of lines) {
                if (!line) continue
                const msg = JSON.parse(line)
                if (msg.type === 'progress') {
                    onProgress?.(msg.bytes, msg.totalBytes)
                } else if (msg.type === 'done') {
                    result = msg
                } else if (msg.type === 'error') {
                    throw new Error(msg.message)
                }
            }
        }
        if (!result) throw new Error('Server backup asset restore: no result received')
        return result
    }

    async deleteServerBackup(filename: string): Promise<void> {
        const da = await this.authFetch(`/api/backup/server/${encodeURIComponent(filename)}`, {
            method: 'DELETE',
        })
        if (da.status === 404) throw new Error('Backup file not found')
        if (da.status < 200 || da.status >= 300) throw new Error(`server backup delete error: ${da.status}`)
    }

    async downloadServerBackup(filename: string): Promise<Response> {
        const da = await this.authFetch(`/api/backup/server/download/${encodeURIComponent(filename)}`)
        if (da.status === 404) throw new Error('Backup file not found')
        if (da.status < 200 || da.status >= 300) throw new Error(`server backup download error: ${da.status}`)
        return da
    }

    // ── Chat content (runtime lazy load) ────────────────────────────────────

    async fetchBookmarkCatalog(): Promise<BookmarkCatalog> {
        const da = await this.authFetch(BOOKMARKS_API_PATH)
        if (da.status < 200 || da.status >= 300) {
            throw new Error(`fetchBookmarks error: ${da.status}`)
        }
        return await da.json() as BookmarkCatalog
    }

    async putBookmark(entry: BookmarkTarget & { name: string, tagIds?: string[] }): Promise<BookmarkCatalog> {
        const da = await this.authFetch(BOOKMARKS_API_PATH, {
            method: 'PUT',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(entry),
        })
        if (da.status < 200 || da.status >= 300) throw new Error(`putBookmark error: ${da.status}`)
        return await da.json() as BookmarkCatalog
    }

    async patchBookmark(
        target: BookmarkTarget,
        patch: { name?: string, tagIds?: string[] },
    ): Promise<BookmarkCatalog> {
        const da = await this.authFetch(BOOKMARKS_API_PATH, {
            method: 'PATCH',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ ...target, ...patch }),
        })
        if (da.status < 200 || da.status >= 300) throw new Error(`patchBookmark error: ${da.status}`)
        return await da.json() as BookmarkCatalog
    }

    async deleteBookmark(target: BookmarkTarget): Promise<BookmarkCatalog> {
        const da = await this.authFetch(BOOKMARKS_API_PATH, {
            method: 'DELETE',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(target),
        })
        if (da.status < 200 || da.status >= 300) throw new Error(`deleteBookmark error: ${da.status}`)
        return await da.json() as BookmarkCatalog
    }

    async replaceBookmarkTags(tags: { id: string, name: string }[]): Promise<BookmarkCatalog> {
        const da = await this.authFetch(BOOKMARK_TAGS_API_PATH, {
            method: 'PUT',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ tags }),
        })
        if (da.status < 200 || da.status >= 300) throw new Error(`bookmarkTags error: ${da.status}`)
        return await da.json() as BookmarkCatalog
    }

    async mergeBookmarkTags(tags: unknown): Promise<{ idMap: Record<string, string>, catalog: BookmarkCatalog }> {
        const da = await this.authFetch(`${BOOKMARK_TAGS_API_PATH}/merge`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ tags }),
        })
        if (da.status < 200 || da.status >= 300) throw new Error(`mergeBookmarkTags error: ${da.status}`)
        return await da.json()
    }

    async fetchBookmarkCompatibility(
        targets: Array<{ characterId: string, chatId: string }>,
    ): Promise<BookmarkCompatibilityResult> {
        const da = await this.authFetch(`${BOOKMARKS_API_PATH}/compatibility`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ targets }),
        })
        if (da.status < 200 || da.status >= 300) {
            throw new Error(`bookmarkCompatibility error: ${da.status}`)
        }
        return await da.json() as BookmarkCompatibilityResult
    }

    async fetchChatContent(chaId: string, chatIndex: number, chatId: string): Promise<any | null> {
        const da = await this.authFetch(`/api/chat-content/${encodeURIComponent(chaId)}/${chatIndex}`, {
            headers: { 'x-chat-id': chatId },
        }, CHAT_CONTENT_READ_POLICY)
        if (da.status === 404) return null
        if (da.status < 200 || da.status >= 300) throw await storageRequestError('fetchChatContent', da)
        const etag = da.headers.get('x-chat-etag')
        if (etag) this.chatEtags.set(`${chaId}\u0000${chatId}`, etag)
        const buffer = new Uint8Array(await da.arrayBuffer())
        return normalizeChat(await decodeRisuSave(buffer))
    }

    async saveChatContent(
        chaId: string,
        chatIndex: number,
        chatId: string,
        chat: any,
        commit?: { expectedEtag?: string },
    ): Promise<void> {
        const encoded = encodeRisuSaveLegacy(chat)
        const chatKey = `${chaId}\u0000${chatId}`
        const headers: Record<string, string> = {
            'content-type': 'application/octet-stream',
            'x-chat-id': chatId,
        }
        const expectedEtag = commit
            ? commit.expectedEtag
            : this.chatEtags.get(chatKey)
        if (expectedEtag) headers['x-chat-if-match'] = expectedEtag
        const da = await this.authFetch(`/api/chat-content/${encodeURIComponent(chaId)}/${chatIndex}`, {
            method: 'POST',
            headers,
            body: encoded,
        })
        if (da.status === 409) {
            const data = await da.json().catch(() => ({}))
            throw new ConflictError(data.error || 'Chat body conflict', data.currentEtag || '')
        }
        if (da.status < 200 || da.status >= 300) throw await storageRequestError('saveChatContent', da)
        const data = await da.json()
        if (data.error) throw new StorageRequestError('saveChatContent', da.status, String(data.error))
        if (typeof data.etag === 'string') this.chatEtags.set(chatKey, data.etag)
    }

    getChatEtag(chaId: string, chatId: string): string | undefined {
        return this.chatEtags.get(`${chaId}\u0000${chatId}`)
    }

    setChatEtag(chaId: string, chatId: string, etag: string): void {
        this.chatEtags.set(`${chaId}\u0000${chatId}`, etag)
    }

}

async function digestPassword(message:string) {
    const res = await fetch('/api/crypto', {
        body: JSON.stringify({
            data: message
        }),
        headers: {
            'content-type': 'application/json'
        },
        method: "POST"
    })
    if(res.status < 200 || res.status >= 300){
        throw new Error(`Password hashing failed (${res.status})`)
    }
    return await res.text()
}
