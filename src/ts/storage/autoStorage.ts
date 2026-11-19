import { isDebugEnabled } from 'src/ts/debug'
import { Buffer } from 'buffer'
import {
    NodeStorage,
    type DatabaseProjection,
    type ExportBackupOptions,
    type BackupProgress,
    type PatchItemResult,
    type DeltaPatch,
    type FileFormat,
    type PluginStorageNamespace,
    type PluginStorageRequest,
    type PluginStorageResponse,
} from "./nodeStorage"

export class AutoStorage{
    realStorage:NodeStorage

    async setItem(key:string, value:Uint8Array, etag?:string):Promise<string|null> {
        await this.realStorage.setItem(key, value, etag)
        return null
    }
    async getItem(key:string):Promise<Buffer> {
        return await this.realStorage.getItem(key)
    }
    async keys(prefix: string = '', options?: { order?: 'updated-desc'; limit?: number; offset?: number }):Promise<string[]>{
        await this.Init()
        return await this.realStorage.keys(prefix, options)
    }
    async keyPage(prefix: string = '', options?: { order?: 'updated-desc'; limit?: number; offset?: number }) {
        await this.Init()
        return await this.realStorage.keyPage(prefix, options)
    }
    async removeItem(key:string){
        return await this.realStorage.removeItem(key)
    }

    async Init(){
        if(!this.realStorage){
            if (isDebugEnabled()) {
                console.debug("using node storage")
            }
            this.realStorage = new NodeStorage()
        }
    }

    async createAuth(): Promise<string> {
        await this.Init()
        return this.realStorage.createAuth()
    }

    async downloadBackupExport(
        opts?: ExportBackupOptions,
        onProgress?: (progress: BackupProgress) => void,
    ) {
        await this.Init()
        return this.realStorage.downloadBackupExport(opts, onProgress)
    }

    async downloadAsset(key: string, filename?: string) {
        await this.Init()
        return this.realStorage.downloadAsset(key, filename)
    }
    async settingsBackupEstimate() {
        await this.Init()
        return this.realStorage.settingsBackupEstimate()
    }

    async importBackup(file: Blob, onProgress?: (loaded: number, total: number) => void) {
        await this.Init()
        return this.realStorage.importBackup(file, onProgress)
    }

    async encodeFile(format: FileFormat, value: unknown) {
        await this.Init()
        return this.realStorage.encodeFile(format, value)
    }

    async decodeFile(format: FileFormat, bytes: Uint8Array) {
        await this.Init()
        return this.realStorage.decodeFile(format, bytes)
    }

    async getDatabaseProjection<T = unknown>(): Promise<DatabaseProjection<T>> {
        await this.Init()
        return this.realStorage.getDatabaseProjection<T>()
    }

    async getPluginStorageStartupStats() {
        await this.Init()
        return this.realStorage.getPluginStorageStartupStats()
    }

    async pluginStorageRequest(namespace: PluginStorageNamespace, request: PluginStorageRequest): Promise<PluginStorageResponse> {
        await this.Init()
        return this.realStorage.pluginStorageRequest(namespace, request)
    }

    setPluginStorageExclusion(exclusion: Parameters<NodeStorage['setPluginStorageExclusion']>[0]) {
        this.realStorage.setPluginStorageExclusion(exclusion)
    }

    async initializeDatabase<T>(database: T, expectedRevision = 0): Promise<PatchItemResult> {
        await this.Init()
        return this.realStorage.initializeDatabase(database, expectedRevision)
    }

    async patchDatabase(patchData: DeltaPatch): Promise<PatchItemResult> {
        await this.Init()
        return this.realStorage.patchDatabase(patchData)
    }

    getDbEtag(): string | null {
        return this.realStorage._lastDbEtag
    }

    setDbEtag(etag: string | null) {
        this.realStorage.setDbEtag(etag)
    }

    getDbRevision(): number | null {
        return this.realStorage._lastDbRevision
    }

    async getItems(keys: string[]) { return this.realStorage.getItems(keys) }
    async setItems(entries: {key: string, value: Uint8Array}[]) { return this.realStorage.setItems(entries) }

    async saveServerBackup(note = '', onProgress?: (progress: BackupProgress) => void) {
        await this.Init()
        return this.realStorage.saveServerBackup(note, onProgress)
    }
    async listServerBackups() { await this.Init(); return this.realStorage.listServerBackups() }
    async restoreServerBackup(filename: string, onProgress?: (bytes: number, totalBytes: number) => void) { await this.Init(); return this.realStorage.restoreServerBackup(filename, onProgress) }
    async restoreMissingServerBackupAssets(filename: string, onProgress?: (bytes: number, totalBytes: number) => void) { await this.Init(); return this.realStorage.restoreMissingServerBackupAssets(filename, onProgress) }
    async deleteServerBackup(filename: string) { await this.Init(); return this.realStorage.deleteServerBackup(filename) }
    async downloadServerBackup(filename: string) { await this.Init(); return this.realStorage.downloadServerBackup(filename) }

}

/** Process-wide storage facade shared by persistence and network services. */
export const forageStorage = new AutoStorage()
