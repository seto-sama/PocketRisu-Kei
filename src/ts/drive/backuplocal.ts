import { alertClear, alertConfirm, alertConfirmMulti, alertError, alertStore, alertWait, waitAlert, notifySuccess } from "../alert";
import { forageStorage, requestImmediateSave } from "../globalApi.svelte";
import { getSyncClientId, type BackupProgress, type BackupRestoreResult, type ExportBackupOptions } from "../storage/nodeStorage";
import { language } from "src/lang";
import { apiRequestError } from "../network/apiError";
import { selectFileByDom } from "../util";

async function flushClientDatabaseChanges() {
    await requestImmediateSave({ requireSuccess: true });
}

function showBackupProgress(title: string, progress: BackupProgress) {
    if (progress.stage === 'saving' || progress.stage === 'preparing') {
        alertWait(progress.stage === 'saving' ? language.backupLocalSaving : language.backupLocalPreparing, title)
    } else {
        const message = progress.stage === 'compressing'
            ? language.backupLocalCompressing
            : progress.stage === 'writing'
                ? language.serverBackupSaving
                : language.backupLocalPreparing
        const bytes = progress.stage === 'compressing' ? progress.backupBytes : progress.totalBytes
        const percent = progress.totalBytes > 0 ? Math.floor(progress.bytes / progress.totalBytes * 100) : 0
        alertStore.set({
            type: 'progress',
            title,
            msg: message,
            submsg: String(percent),
            progressDetail: formatBytes(bytes),
        })
    }
}

async function downloadLocalBackup(options?: ExportBackupOptions) {
    const title = options?.mode === 'settings' ? language.backupSettingsOnly
        : options?.mode === 'partial' ? language.savePartialLocalBackup
            : options?.target === 'upstream' ? language.saveBackupForUpstream
                : language.backupLocal
    alertWait(language.backupLocalSaving, title)
    await flushClientDatabaseChanges();
    return await forageStorage.downloadBackupExport(options, (progress) => showBackupProgress(title, progress))
}

function formatBytes(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`
}

export async function SaveLocalBackup(options?: ExportBackupOptions){
    try {
        const result = await downloadLocalBackup(options)
        notifySuccess(language.browserDownloadStarted, result.missingAssets.length
            ? { description: language.backupMissingAssets(result.missingAssets.join('\n')) }
            : undefined)
        return result
    } catch (error) {
        alertError(error)
    }
}

export async function SaveSettingsOnlyBackup(){
    let includeModuleAssets = true
    try {
        alertWait(language.backupLocalSaving, language.backupSettingsOnly)
        await flushClientDatabaseChanges();
        alertWait(language.backupSettingsOnlyEstimating, language.backupSettingsOnly)
        const estimate = await forageStorage.settingsBackupEstimate()
        alertClear()

        const baseBytes = estimate.dbBytes + estimate.pluginStorageBytes + estimate.baseAssets.bytes
        if(estimate.moduleAssets.count > 0){
            const choice = await alertConfirmMulti(
                language.backupSettingsOnly,
                [
                    language.backupSettingsOnlyWithModuleAssets(
                        formatBytes(baseBytes + estimate.moduleAssets.bytes),
                    ),
                    language.backupSettingsOnlyWithoutModuleAssets(formatBytes(baseBytes)),
                ],
                language.backupSettingsOnlyBreakdown(
                    formatBytes(baseBytes),
                    estimate.moduleAssets.moduleCount,
                    estimate.moduleAssets.count,
                    formatBytes(estimate.moduleAssets.bytes),
                ),
            )
            if(choice !== 0 && choice !== 1) return
            includeModuleAssets = choice === 0
        }
        else if(!(await alertConfirm(language.backupSettingsOnlyConfirm(formatBytes(baseBytes))))){
            return
        }

        await downloadLocalBackup({
            mode: 'settings',
            moduleAssets: includeModuleAssets,
        })
        notifySuccess(language.browserDownloadStarted, includeModuleAssets ? undefined : {
            description: language.backupSettingsOnlyModuleAssetsSkipped,
        })
    }
    catch(error){
        alertClear()
        console.error(error)
        alertError(language.backupSettingsOnlyFailed)
    }
}

export async function SaveLocalBackupForUpstream(){
    await SaveLocalBackup({ target: 'upstream' })
}

export async function SavePartialLocalBackup(){
    const firstConfirm = await alertConfirm(language.partialBackupFirstConfirm)
    
    if (!firstConfirm) {
        return
    }
    
    const secondConfirm = await alertConfirm(language.partialBackupSecondConfirm)
    
    if (!secondConfirm) {
        return
    }

    await SaveLocalBackup({ mode: 'partial' })
}

export async function finishBackupRestore(result: BackupRestoreResult) {
    const failures = [
        result.coldStorageFailed ? `${result.coldStorageFailed} character(s)` : '',
        result.pluginStorageColdFailed ? `${result.pluginStorageColdFailed} plugin storage item(s)` : '',
    ].filter(Boolean).join(' and ')
    const warnings = [
        failures ? `${failures} could not be restored from cold storage.` : '',
        result.skippedSaveBlocks?.length ? `RisuAI SaveKV data is not supported and was left out: ${result.skippedSaveBlocks.join(', ')}.` : '',
    ].filter(Boolean).join(' ')
    if (warnings) {
        alertError(`Warning: ${warnings} The restored save may be incomplete. The app will now reload.`)
        await waitAlert()
    } else {
        alertWait("Success, Refreshing your app.");
    }
    location.search = ''
    location.reload()
}

export async function LoadLocalBackup(){
    try {
        const [file] = await selectFileByDom(['bin']);
        if (!file) return;
        const selectedFile = language.backupSelectedFile(file.name);
        if (!(await alertConfirm(language.backupLoadConfirm, selectedFile))) return;
        if (!(await alertConfirm(language.backupLoadConfirm2, selectedFile))) return;
        const message = language.backupLocalRestoring;
        const title = language.loadBackupLocal;
        alertWait(message, title);
        const result = await forageStorage.importBackup(file, (loaded, total) => {
            if (total > 0) {
                alertStore.set({
                    type: 'progress',
                    title,
                    msg: message,
                    submsg: String(loaded / total * 100),
                })
            } else {
                alertWait(message, title)
            }
        })
        await finishBackupRestore(result)
    } catch (error) {
        alertError(error)
    }
}

export async function SaveServerBackup(note = '') {
    try {
        alertWait(language.backupLocalSaving, language.serverBackupSave)
        await flushClientDatabaseChanges();
        const result = await forageStorage.saveServerBackup(note, (progress) => {
            showBackupProgress(language.serverBackupSave, progress)
        })
        notifySuccess(language.serverBackupSaveSuccess(result.filename, formatBytes(result.size)))
        return result
    } catch (error) {
        alertError(error)
        return null
    }
}

export async function SaveManualSnapshot(note = '') {
    try {
        await flushClientDatabaseChanges();
        alertWait(language.manualSnapshotSaving, language.manualSnapshotCreate)
        const auth = await forageStorage.createAuth()
        const res = await fetch('/api/db/manual-snapshots', {
            method: 'POST',
            headers: { 'risu-auth': auth, 'x-sync-client-id': getSyncClientId(), 'content-type': 'application/json' },
            body: JSON.stringify({ note }),
        })
        if (!res.ok) {
            throw await apiRequestError(res, 'Manual snapshot failed')
        }
        const json = await res.json().catch(() => ({}))
        notifySuccess(language.manualSnapshotSaveSuccess(json?.snapshot?.filename ?? 'snapshot'))
        return json
    } catch (error) {
        console.error(error)
        alertError(error instanceof Error ? error.message : 'Manual snapshot failed')
        return null
    }
}
