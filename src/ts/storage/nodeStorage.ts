import { encodeAssetBatch, decodeAssetBatch, getAssetUrl } from './assetTransport'
import { downloadUrl } from '../download'
import { createEntityId } from '../id'
import { BINARY_MESSAGE_CONTENT_TYPE } from '../network/binaryMessage'
import { Buffer } from 'buffer'
import { encode, decode } from 'msgpackr/index-no-eval'
import { validateContentReferences, type ContentReferenceKind } from '../../../shared/contentReferences.mjs'
import { language } from "src/lang"
import { alertInput } from "../alert"
import { decodeRisuSave } from "./risuSave"
import { normalizeChat } from "./database.svelte"
import { apiErrorCodes, apiRequestError, localizedApiErrorMessage } from '../network/apiError'
import { CHAT_CONTENT_READ_POLICY, ConflictError, storageRequestError, StorageRequestError } from './storageRequest'
export { ConflictError } from './storageRequest'
import { fetchWithRequestTimeout } from '../../../shared/requestTimeout.mjs'
import { isPatchHashDiagnostics, type PatchHashDiagnostics } from '../../../shared/patchHashDiagnostics.mjs'
import { type createDelta } from '../../../shared/guardedDelta.mjs'
import type {
    BookmarkCatalog,
    BookmarkCompatibilityResult,
    BookmarkTarget,
} from '../bookmarks/bookmarkTypes'

const BOOKMARKS_API_PATH = '/api/bookmarks'
const BOOKMARK_TAGS_API_PATH = '/api/bookmark-tags'

async function ensurePluginStorageMigration(): Promise<void> {
    const { ensurePluginStorageMigration: migrate } = await import('../plugins/pluginSafeClass')
    await migrate()
}

function serverErrorMessage(body: any, fallback: string): string {
    return localizedApiErrorMessage({
        code: typeof body?.code === 'string' ? body.code : undefined,
        message: typeof body?.error === 'string' ? body.error
            : typeof body?.message === 'string' ? body.message : '',
        fallback,
    })
}

async function* readNdjson(response: Response): AsyncGenerator<any> {
    if (!response.body) throw new Error('NDJSON response body is unavailable')

    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    let streamEnded = false

    try {
        while (true) {
            const { done, value } = await reader.read()
            if (done) {
                streamEnded = true
                buffer += decoder.decode()
                break
            }

            buffer += decoder.decode(value, { stream: true })
            const lines = buffer.split('\n')
            buffer = lines.pop() ?? ''
            for (const line of lines) {
                if (line.trim()) yield JSON.parse(line)
            }
        }

        if (buffer.trim()) yield JSON.parse(buffer)
    } finally {
        if (!streamEnded) await reader.cancel().catch(() => {})
        reader.releaseLock()
    }
}

async function readBackupResult<T>(
    response: Response,
    onProgress: ((progress: any) => void) | undefined,
    failureMessage: string,
): Promise<T> {
    let result: T | undefined
    for await (const message of readNdjson(response)) {
        if (message.type === 'progress') {
            const progress = { ...message }
            delete progress.type
            onProgress?.(progress)
        }
        else if (message.type === 'done') result = message
        else if (message.type === 'error') throw new Error(serverErrorMessage(message, failureMessage))
    }
    if (!result) throw new Error(failureMessage)
    return result
}

export interface PersistWarning {
    timestamp: number
    message: string
    attemptedSize: number | null
    source: string
}

export interface BackupRestoreResult {
    ok: boolean
    assetsRestored: number
    coldStorageFailed?: number
    pluginStorageColdFailed?: number
}

export interface PatchItemResult {
    conflictCode?: string
    currentHash?: string
    hashDiagnostics?: PatchHashDiagnostics
    conflicts?: unknown[]
    success: boolean
    etag?: string
    revision?: number
    conflict?: boolean
    persistWarning?: PersistWarning
    chatGuardRejected?: boolean
}

export type DeltaPatch = { changes: ReturnType<typeof createDelta> }
type ProjectionPatch = DeltaPatch | { patch: any[], expectedHash: string }

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

export type PluginStorageNamespace = 'localStorage' | 'localForage'
export type PluginStorageRequest =
    | { op: 'get', key: string }
    | { op: 'set', key: string, value: Uint8Array, owner?: string }
    | { op: 'remove', key: string }
    | { op: 'clear' }
    | { op: 'list' }
    | { op: 'import', entries: Array<{ key: string, value: Uint8Array, owner?: string }> }

export type PluginStorageResponse =
    | { value: Uint8Array | null }
    | { success: true }
    | { entries: Array<{ key: string, owner?: string }> }

export interface ExportBackupOptions {
    target?: 'upstream'
    mode?: 'settings' | 'partial'
    moduleAssets?: boolean
}

export type BackupProgress =
    | { stage: 'saving' }
    | { stage: 'preparing' }
    | { stage: 'compressing', bytes: number, totalBytes: number, backupBytes: number }
    | { stage: 'ready', bytes: number, totalBytes: number }
    | { stage: 'writing', bytes: number, totalBytes: number }

export type FileFormat = 'save' | 'preset' | 'theme' | 'translator' | 'json'

export interface SettingsBackupEstimate {
    dbBytes: number
    pluginStorageBytes: number
    baseAssets: { count: number, bytes: number }
    moduleAssets: { count: number, bytes: number, moduleCount: number }
}

export interface DriveEntry {
    path: string
    name: string
    type: 'file' | 'directory'
    size: number | null
    createdAt: number | null
    modifiedAt: number
}

export type DriveConflict = 'error' | 'overwrite' | 'rename'
export type DriveMergeChoice = 'server' | 'local' | 'both' | null
export interface DriveMergeConflict {
    path: string
    existing: DriveEntry
    incoming: DriveEntry
}
export interface DriveMergePlan {
    revision: string
    conflicts: DriveMergeConflict[]
}
export interface DriveMergeResolution {
    revision: string
    choices: Record<string, DriveMergeChoice>
}
export interface DriveRenameResult {
    entry: DriveEntry
    moves: Array<{ from: string, to: string }>
}

export function getSyncClientId(): string {
    return NodeStorage.getSessionId()
}

export class NodeStorage{
    private static readonly BULK_WRITE_CLIENT_BATCH = 20

    // Each page needs its own id so sync broadcasts can skip the originating page.
    private static sessionId: string = createEntityId()

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

        if (!this.cachedJwt) {
            await this.checkAuth()
            if (!this.cachedJwt) {
                throw new Error('Node auth unavailable')
            }
            return this.cachedJwt.token
        }

        const token = await this._refreshToken()
        if (token) return token

        // Reauthenticate after a rejected refresh to avoid reusing its invalid token.
        this.cachedJwt = null
        this.authChecked = false
        await this.checkAuth()
        if (!this.cachedJwt) {
            throw new Error('Node auth unavailable')
        }
        return this.cachedJwt.token
    }

    // Asset elements cannot attach JWT headers, so they need a session cookie.
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
        } catch {
            // Retry session creation on the next authenticated request.
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

        if(response.status < 200 || response.status >= 300){
            throw await apiRequestError(response, 'Node login failed')
        }

        const data = await response.json()
        if (data.token) {
            this.cachedJwt = { token: data.token, expiresAt: Date.now() + 5 * 60 * 1000 }
        }
        this.authChecked = true
    }

    private async shouldRetryAuth(response: Response) {
        if(response.status !== 401) return false

        try {
            const data = await response.clone().json()
            return [
                apiErrorCodes.AUTH_INVALID_TOKEN,
                apiErrorCodes.AUTH_TOKEN_EXPIRED,
            ].includes(data?.code)
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
            throw new ConflictError(data.error, data.currentEtag, data.code)
        }
        if(da.status < 200 || da.status >= 300){
            throw await storageRequestError('setItem', da)
        }
        const data = await da.json()
        if(data.error){
            throw new StorageRequestError('setItem', da.status, String(data.error), data.code)
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

    async saveInlayVideoThumbnail(id: string, thumbnail: Blob): Promise<void> {
        const response = await this.authFetch(`/api/inlays/${encodeURIComponent(id)}/video-thumbnail`, {
            method: 'POST',
            body: thumbnail,
            headers: { 'content-type': 'application/octet-stream' },
        })
        if (!response.ok) throw await storageRequestError('saveInlayVideoThumbnail', response)
    }

    async getItem(key:string):Promise<Buffer> {
        const headers: Record<string, string> = {
            'file-path': Buffer.from(key, 'utf-8').toString('hex')
        }

        const da = await this.authFetch('/api/read', { method: "GET", headers })
        if(da.status < 200 || da.status >= 300){
            throw await storageRequestError('getItem', da)
        }

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
                    throw await apiRequestError(response, 'Failed to set node password')
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

    setDbEtag(etag: string | null) {
        this._lastDbEtag = etag
    }

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
        // HTTP headers are ASCII; JSON Unicode escapes preserve plugin names.
        this.pluginStorageExclusionHeader = JSON.stringify({
            plugins: pluginNames,
            unclassified: exclusion.unclassified === true,
        }).replace(/[^\x20-\x7e]/g, character => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`)
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

    async pluginStorageRequest(namespace: PluginStorageNamespace, request: PluginStorageRequest): Promise<PluginStorageResponse> {
        const response = await this.authFetch(`/api/plugin-storage/${namespace}`, {
            method: 'POST',
            headers: { 'content-type': BINARY_MESSAGE_CONTENT_TYPE, accept: BINARY_MESSAGE_CONTENT_TYPE },
            body: encode(request),
        })
        if (!response.ok) throw await storageRequestError('pluginStorageRequest', response)
        return decode(new Uint8Array(await response.arrayBuffer())) as PluginStorageResponse
    }

    // Cleanup reads must not advance the autosave baseline.
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

    async getDatabaseProjection<T = unknown>(): Promise<DatabaseProjection<T>> {
        const headers:Record<string, string> = { accept: BINARY_MESSAGE_CONTENT_TYPE }
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

        const data = decode(new Uint8Array(await response.arrayBuffer())) as DatabaseProjection<T>
        this._lastDbEtag = data.etag ?? null
        this._lastDbRevision = Number.isSafeInteger(data.revision) ? data.revision : null
        return data
    }

    // Revision 0 prevents concurrent first-run clients from overwriting each other.
    async initializeDatabase<T>(database: T, expectedRevision = 0): Promise<PatchItemResult> {
        const response = await this.authFetch('/api/database', {
            method: 'PUT',
            body: encode({ database, expectedRevision }),
            headers: { 'content-type': BINARY_MESSAGE_CONTENT_TYPE },
        })
        if (!response.ok && response.status !== 409) throw await storageRequestError('initializeDatabase', response)
        const data = await response.json().catch(() => ({})) as {
            code?: string
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
            throw new StorageRequestError('initializeDatabase', response.status, data.error, data.code)
        }
        return {
            success: true,
            etag,
            revision,
            persistWarning: data.persistWarning,
        }
    }

    async patchDatabase(patchData: ProjectionPatch): Promise<PatchItemResult> {
        return this.sendPatch('/api/database', patchData, true, undefined, 'PATCH')
    }

    async patchItem(key: string, patchData: { patch: any[], expectedHash: string }): Promise<PatchItemResult> {
        return this.sendPatch('/api/patch', patchData, key === 'database/database.bin', key)
    }

    private async sendPatch(
        endpoint: string,
        patchData: ProjectionPatch,
        tracksDatabase: boolean,
        key?: string,
        method: 'POST' | 'PATCH' = 'POST',
    ): Promise<PatchItemResult> {
        if (('changes' in patchData ? patchData.changes : patchData.patch).length === 0) return { success: true }
        const operation = tracksDatabase ? 'patchDatabase' : 'patchItem'
        const binary = method === 'PATCH'

        const headers: Record<string, string> = {
            'content-type': binary ? BINARY_MESSAGE_CONTENT_TYPE : 'application/json',
        }
        if (tracksDatabase && this.pluginStorageExclusionHeader) {
            headers['x-risu-plugin-storage-exclusion'] = this.pluginStorageExclusionHeader
        }
        if (key) {
            headers['file-path'] = Buffer.from(key, 'utf-8').toString('hex')
        }
        const da = await this.authFetch(endpoint, {
            method,
            body: binary ? encode(patchData) : JSON.stringify(patchData),
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
            const rejectedByChatGuard = data.code === apiErrorCodes.CHAT_GUARD_REJECTED
            return {
                success: false,
                etag: currentEtag,
                revision: currentRevision,
                conflict: !rejectedByChatGuard,
                conflictCode: typeof data.code === 'string' ? data.code : undefined,
                currentHash: typeof data.currentHash === 'string' ? data.currentHash : undefined,
                hashDiagnostics: isPatchHashDiagnostics(data.hashDiagnostics) ? data.hashDiagnostics : undefined,
                chatGuardRejected: rejectedByChatGuard,
                conflicts: Array.isArray(data.conflicts) ? data.conflicts : undefined,
            }
        }
        if (da.status < 200 || da.status >= 300) {
            throw await storageRequestError(operation, da)
        }
        const data = await da.json()
        if (data.error) {
            throw new StorageRequestError(operation, da.status, String(data.error), data.code)
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

    async getItems(keys: string[]): Promise<{key: string, value: Buffer}[]> {
        const da = await this.authFetch('/api/assets/bulk-read', {
            method: 'POST',
            body: JSON.stringify(keys),
            headers: {
                'content-type': 'application/json',
                'accept': BINARY_MESSAGE_CONTENT_TYPE
            }
        })
        if (da.status < 200 || da.status >= 300) throw await storageRequestError('getItems', da)

        const entries = decodeAssetBatch(new Uint8Array(await da.arrayBuffer()))
        // Each cached asset owns its bytes instead of retaining the entire batch.
        return entries.map(({ key, value }) => ({ key, value: Buffer.from(value) }))
    }

    async setItems(entries: {key: string, value: Uint8Array}[]) {
        for (let i = 0; i < entries.length; i += NodeStorage.BULK_WRITE_CLIENT_BATCH) {
            const batch = entries.slice(i, i + NodeStorage.BULK_WRITE_CLIENT_BATCH)
            const da = await this.authFetch('/api/assets/bulk-write', {
                method: 'POST',
                body: encodeAssetBatch(batch),
                headers: { 'content-type': BINARY_MESSAGE_CONTENT_TYPE },
            })
            if (da.status < 200 || da.status >= 300) throw await storageRequestError('setItems', da)
        }
    }

    async downloadBackupExport(
        opts?: ExportBackupOptions,
        onProgress?: (progress: BackupProgress) => void,
    ): Promise<{ missingAssets: string[] }> {
        await ensurePluginStorageMigration()
        const params = new URLSearchParams()
        if(opts?.target === 'upstream') params.set('target', 'upstream')
        if(opts?.mode) params.set('mode', opts.mode)
        if(opts?.moduleAssets === false) params.set('moduleAssets', '0')
        const query = params.toString()
        const prepared = await this.authFetch(`/api/backup/export/prepare${query ? `?${query}` : ''}`, {
            method: 'POST',
            headers: { accept: 'application/x-ndjson' },
        })
        if (!prepared.ok) throw await apiRequestError(prepared)
        const download = await readBackupResult<{ url: string, missingAssets?: string[] }>(
            prepared,
            onProgress,
            'Backup export failed',
        )
        if (!download.url) throw new Error('Backup export: no download URL received')
        await this.startCookieDownload(download.url)
        return { missingAssets: download.missingAssets ?? [] }
    }

    private async fileFormatRequest(format: FileFormat, action: 'encode' | 'decode', body: Uint8Array): Promise<Uint8Array> {
        const response = await this.authFetch(`/api/file-formats/${format}/${action}`, {
            method: 'POST',
            headers: { 'content-type': BINARY_MESSAGE_CONTENT_TYPE },
            body: body as Uint8Array<ArrayBuffer>,
        })
        if (!response.ok) throw await apiRequestError(response)
        return new Uint8Array(await response.arrayBuffer())
    }

    async encodeFile(format: FileFormat, value: unknown): Promise<Uint8Array> {
        return this.fileFormatRequest(format, 'encode', encode(value))
    }

    async decodeFile(format: FileFormat, bytes: Uint8Array): Promise<any> {
        return decode(await this.fileFormatRequest(format, 'decode', bytes))
    }

    private async startCookieDownload(url: string): Promise<void> {
        // Refresh only the download cookie, without registering a sync client.
        const response = await fetch('/api/session', {
            method: 'POST',
            headers: { 'risu-auth': await this.createAuth() },
        })
        if (!response.ok) throw await storageRequestError('startCookieDownload', response)
        downloadUrl(url)
    }

    async downloadAsset(key: string, filename?: string): Promise<void> {
        const params = new URLSearchParams({ download: '1' })
        if (filename) params.set('filename', filename)
        await this.startCookieDownload(`${getAssetUrl(key)}?${params}`)
    }

    private async driveRequest<T>(url: string, init?: RequestInit): Promise<T> {
        const response = await this.authFetch(`/api/drive${url}`, init)
        if (!response.ok) throw await apiRequestError(response)
        return response.json()
    }

    async listDrive(path = '', signal?: AbortSignal): Promise<{ path: string, entries: DriveEntry[] }> {
        return this.driveRequest(`?${new URLSearchParams({ path })}`, { signal })
    }

    async driveMetadata(path: string, signal?: AbortSignal): Promise<DriveEntry> {
        return this.driveRequest(`/metadata?${new URLSearchParams({ path })}`, { signal })
    }

    async createDriveDirectory(path: string, name: string, conflict: DriveConflict = 'error'): Promise<DriveEntry> {
        const result = await this.driveRequest<{ entry: DriveEntry }>('/directory', {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ path, name, conflict }),
        })
        return result.entry
    }

    async renameDriveEntry(path: string, name: string, conflict: DriveConflict = 'error', merge?: DriveMergeResolution, destination?: string): Promise<DriveRenameResult> {
        return this.driveRequest('/rename', {
            method: 'PATCH', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ path, name, conflict, merge, destination }),
        })
    }

    async copyDriveEntry(path: string, name: string, conflict: DriveConflict = 'error', merge?: DriveMergeResolution, destination?: string): Promise<DriveEntry> {
        const result = await this.driveRequest<{ entry: DriveEntry }>('/copy', {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ path, name, conflict, merge, destination }),
        })
        return result.entry
    }

    async deleteDriveEntry(path: string): Promise<void> {
        await this.driveRequest('/entry', {
            method: 'DELETE', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ path }),
        })
    }

    async emptyDriveTrash(): Promise<void> {
        await this.driveRequest('/trash', { method: 'DELETE' })
    }

    async uploadDriveFile(path: string, file: File, signal?: AbortSignal, conflict: DriveConflict = 'error'): Promise<DriveEntry> {
        const result = await this.driveRequest<{ entry: DriveEntry }>(`/file?${new URLSearchParams({ path, name: file.name, conflict })}`, {
            method: 'PUT', headers: { 'content-type': 'application/octet-stream' },
            body: file, signal,
        })
        return result.entry
    }

    async downloadDriveFile(path: string): Promise<void> {
        await this.startCookieDownload(`/api/drive/download?${new URLSearchParams({ path })}`)
    }

    driveThumbnailUrl(entry: DriveEntry): string {
        return `/api/drive/thumbnail?${new URLSearchParams({ path: entry.path, v: `${entry.modifiedAt}:${entry.size}` })}`
    }

    async readDriveFile(path: string, signal?: AbortSignal): Promise<File> {
        const response = await this.authFetch(`/api/drive/download?${new URLSearchParams({ path })}`, { signal })
        if (!response.ok) throw await apiRequestError(response)
        const blob = await response.blob()
        return new File([blob], path.split('/').pop(), { type: blob.type })
    }

    async settingsBackupEstimate(): Promise<SettingsBackupEstimate> {
        await ensurePluginStorageMigration()
        const response = await this.authFetch('/api/backup/export/settings-estimate')
        if(!response.ok) throw new Error(`settings estimate error: ${response.status}`)
        return await response.json()
    }

    async prepareImport(size: number): Promise<void> {
        await ensurePluginStorageMigration()
        const da = await this.authFetch('/api/backup/import/prepare', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ size }),
        })
        if (!da.ok) throw await storageRequestError('prepareImport', da)
    }

    async importBackup(
        file: Blob,
        onProgress?: (loaded: number, total: number) => void
    ): Promise<BackupRestoreResult> {
        await this.prepareImport(file.size)
        const authHeader = await this.createAuth()

        return await new Promise((resolve, reject) => {
            const xhr = new XMLHttpRequest()
            xhr.open('POST', '/api/backup/import')
            xhr.setRequestHeader('content-type', 'application/x-risu-backup')
            xhr.setRequestHeader('risu-auth', authHeader)
            xhr.setRequestHeader('x-sync-client-id', NodeStorage.sessionId)
            // Stream restore progress to prevent reverse-proxy timeouts after upload.
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
            let result: BackupRestoreResult | null = null
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
                        // Reuse the upload progress UI for server-side restoration.
                        onProgress?.(msg.bytes, msg.totalBytes)
                    } else if (msg.type === 'done') {
                        result = msg
                    } else if (msg.type === 'error') {
                        serverErrorMsg = serverErrorMessage(msg, 'backup import failed')
                    }
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

    async saveServerBackup(
        note = '',
        onProgress?: (progress: BackupProgress) => void
    ): Promise<{ok: boolean, filename: string, size: number}> {
        await ensurePluginStorageMigration()
        const da = await this.authFetch('/api/backup/server/save', {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                'x-sync-client-id': NodeStorage.sessionId,
            },
            body: JSON.stringify({ note }),
        })
        if (da.status < 200 || da.status >= 300) {
            throw await storageRequestError('saveServerBackup', da)
        }

        return readBackupResult(da, onProgress, 'Server backup save failed')
    }

    async listServerBackups(): Promise<{backups: Array<{filename: string, size: number, createdAt: number, note?: string}>}> {
        const da = await this.authFetch('/api/backup/server/list')
        if (da.status < 200 || da.status >= 300) throw new Error(`server backup list error: ${da.status}`)
        return da.json()
    }

    async restoreServerBackup(
        filename: string,
        onProgress?: (bytes: number, totalBytes: number) => void
    ): Promise<BackupRestoreResult> {
        const da = await this.authFetch('/api/backup/server/restore', {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                'x-sync-client-id': NodeStorage.sessionId,
            },
            body: JSON.stringify({ filename }),
        })
        if (da.status < 200 || da.status >= 300) {
            throw await storageRequestError('restoreServerBackup', da)
        }

        return readBackupResult(da, (progress) => onProgress?.(progress.bytes, progress.totalBytes), 'Server backup restore failed')
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
        if (da.status < 200 || da.status >= 300) {
            throw await storageRequestError('restoreMissingServerBackupAssets', da)
        }

        return readBackupResult(da, (progress) => onProgress?.(progress.bytes, progress.totalBytes), 'Server backup asset restore failed')
    }

    async deleteServerBackup(filename: string): Promise<void> {
        const da = await this.authFetch(`/api/backup/server/${encodeURIComponent(filename)}`, {
            method: 'DELETE',
        })
        if (!da.ok) throw await storageRequestError('deleteServerBackup', da)
    }

    async downloadServerBackup(filename: string): Promise<void> {
        await this.startCookieDownload(`/api/backup/server/download/${encodeURIComponent(filename)}`)
    }

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

    async fetchChatState(chaId: string, chatIndex: number, chatId: string): Promise<{ chat: any, baseline: any, etag?: string } | null> {
        const da = await this.authFetch(`/api/chat-content/${encodeURIComponent(chaId)}/${chatIndex}`, {
            headers: { 'x-chat-id': chatId },
        }, CHAT_CONTENT_READ_POLICY)
        if (da.status === 404) return null
        if (da.status < 200 || da.status >= 300) throw await storageRequestError('fetchChatState', da)
        const etag = da.headers.get('x-chat-etag')
        const buffer = new Uint8Array(await da.arrayBuffer())
        const decoded = await decodeRisuSave(buffer)
        const baseline = JSON.parse(JSON.stringify(decoded))
        const chat = normalizeChat(decoded)
        if (etag) this.chatEtags.set(`${chaId}\u0000${chatId}`, etag)
        return { chat, baseline, etag: etag ?? undefined }
    }

    async patchChatContent(chaId: string, chatIndex: number, chatId: string, patch: DeltaPatch): Promise<{ etag: string }> {
        const response = await this.authFetch(`/api/chat-content/${encodeURIComponent(chaId)}/${chatIndex}`, {
            method: 'PATCH',
            headers: { 'content-type': 'application/json', 'x-chat-id': chatId },
            body: JSON.stringify(patch),
        })
        if (response.status === 409) {
            const data = await response.json().catch(() => ({}))
            throw new ConflictError(data.error || 'Chat body conflict', data.currentEtag || '', data.code)
        }
        if (!response.ok) throw await storageRequestError('patchChatContent', response)
        const result = await response.json()
        if (result.error) throw new StorageRequestError('patchChatContent', response.status, String(result.error), result.code)
        if (typeof result.etag !== 'string') throw new Error('Chat patch response has no ETag')
        this.chatEtags.set(`${chaId}\u0000${chatId}`, result.etag)
        return { etag: result.etag }
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
        throw await apiRequestError(res, 'Password hashing failed')
    }
    return await res.text()
}
