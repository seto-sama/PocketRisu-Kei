import { withExportColorSchemes } from "../../../server/shared/colorScheme.js";
import { alertClear, alertConfirm, alertConfirmMulti, alertError, alertStore, alertWait, alertMd, waitAlert, notifySuccess, notifyInfo } from "../alert";
import { LocalWriter, forageStorage } from "../globalApi.svelte";
import { getDatabase, type Chat } from "../storage/database.svelte";
import { fetchChatFromServer } from "../storage/chatStorage";
import { getSyncClientId, type ExportBackupOptions } from "../storage/nodeStorage";
import { language } from "src/lang";
import { apiRequestError } from "../network/apiError";

function formatBytes(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`
}

export async function SaveLocalBackup(options?: ExportBackupOptions){
    try {
        await forageStorage.downloadBackupExport(options)
        notifyInfo(language.browserDownloadStarted)
    } catch (error) {
        console.error(error)
        alertError('Failed')
    }
}

export async function SaveSettingsOnlyBackup(){
    let includeModuleAssets = true
    try {
        alertWait(language.backupSettingsOnlyEstimating)
        const estimate = await forageStorage.settingsBackupEstimate()
        alertClear()

        const baseBytes = estimate.dbBytes + estimate.baseAssets.bytes
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

        await forageStorage.downloadBackupExport({
            mode: 'settings',
            moduleAssets: includeModuleAssets,
        })
        notifyInfo(language.browserDownloadStarted, includeModuleAssets ? undefined : {
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

/** Saves database content and profile, persona, folder, and preset images. */
export async function SavePartialLocalBackup(){
    const firstConfirm = await alertConfirm(language.partialBackupFirstConfirm)
    
    if (!firstConfirm) {
        return
    }
    
    const secondConfirm = await alertConfirm(language.partialBackupSecondConfirm)
    
    if (!secondConfirm) {
        return
    }
    
    alertWait("Saving partial local backup...")
    const writer = new LocalWriter()
    const r = await writer.init()
    if(!r){
        alertError('Failed')
        return
    }

    const db = getDatabase()
    const assetMap = new Map<string, { charName: string, assetName: string }>()
    
    // Only collect main profile images for both characters and groups
    if (db.characters) {
        for (const char of db.characters) {
            if (!char) continue
            const charName = char.name ?? 'Unknown Character'
            
            // Save the main profile image (supports both character and group types)
            // Note: emotionImages are intentionally excluded from partial backup
            if (char.image) {
                assetMap.set(char.image, { charName: charName, assetName: 'Profile Image' })
            }
        }
    }
    
    // User icon
    if (db.userIcon) {
        assetMap.set(db.userIcon, { charName: 'User Settings', assetName: 'User Icon' })
    }
    
    // Persona icons
    if (db.personas) {
        for (const persona of db.personas) {
            if (persona && persona.icon) {
                assetMap.set(persona.icon, { charName: 'Persona', assetName: `${persona.name} Icon` })
            }
        }
    }
    
    // Custom background
    if (db.customBackground) {
        assetMap.set(db.customBackground, { charName: 'User Settings', assetName: 'Custom Background' })
    }
    
    // Folder images in characterOrder
    if (db.characterOrder) {
        for (const item of db.characterOrder) {
            if (typeof item !== 'string' && item.img) {
                assetMap.set(item.img, { charName: 'Folder', assetName: `${item.name} Folder Image` })
            }
            if (typeof item !== 'string' && item.imgFile) {
                assetMap.set(item.imgFile, { charName: 'Folder', assetName: `${item.name} Folder Image File` })
            }
        }
    }
    
    // Bot preset images
    if (db.botPresets) {
        for (const preset of db.botPresets) {
            if (preset && preset.image) {
                assetMap.set(preset.image, { charName: 'Preset', assetName: `${preset.name} Preset Image` })
            }
        }
    }
    
    const missingAssets: string[] = []

    const assetKeys = Array.from(assetMap.keys())

    for(let i=0;i<assetKeys.length;i++){
        const key = assetKeys[i]
        let message = `Saving partial local backup... (${i + 1} / ${assetKeys.length})`
        if (missingAssets.length > 0) {
            const skippedItems = missingAssets.map(key => {
                const assetInfo = assetMap.get(key);
                return assetInfo ? `'${assetInfo.assetName}' from ${assetInfo.charName}` : `'${key}'`;
            }).join(', ');
            message += `\n(Skipping... ${skippedItems})`;
        }
        alertWait(message)

        if(!key || !key.endsWith('.png')){
            continue
        }

        const data = await forageStorage.getItem(key) as unknown as Uint8Array

        if (data) {
            await writer.writeBackup(key, data)
        } else {
            missingAssets.push(key)
        }
    }

    // Reassemble full chats from server for placeholders (runtime lazy load)
    alertWait(`Saving partial local backup... (Assembling chat data)`)
    const dbCopy = structuredClone(db)
    for (const char of dbCopy.characters) {
        for (let i = 0; i < char.chats.length; i++) {
            const chat = char.chats[i]
            if (chat._placeholder && chat.id) {
                const full = await fetchChatFromServer(char.chaId, i, chat.id, { trackBaseline: false })
                if (full) {
                    char.chats[i] = full as Chat
                } else {
                    throw new Error(`Chat data missing for "${char.name}" / "${chat.name}" (${chat.id}). Backup aborted to prevent data loss.`)
                }
            }
        }
    }
    const dbData = await forageStorage.encodeFile('save', withExportColorSchemes(dbCopy))

    alertWait(`Saving partial local backup... (Saving database)`) 

    await writer.writeBackup('database.risudat', dbData)
    await writer.close()

    if (missingAssets.length > 0) {
        let message = 'Partial backup successful, but the following profile images were missing and skipped:\n\n'
        for (const key of missingAssets) {
            const assetInfo = assetMap.get(key)
            if (assetInfo) {
                message += `* **${assetInfo.assetName}** (from *${assetInfo.charName}*)  \n  *File: ${key}*\n`
            } else {
                message += `* **Unknown Asset**  \n  *File: ${key}*\n`
            }
        }
        alertMd(message)
    } else {
        notifySuccess('Success')
    }
}

export function LoadLocalBackup(){
    try {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = '.bin';
        input.onchange = async () => {
            if (!input.files || input.files.length === 0) {
                input.remove();
                return;
            }
            const file = input.files[0];
            input.remove();
            alertWait(`Loading local Backup... (Uploading ${file.name})`);
            const result = await forageStorage.importBackup(file, (loaded, total) => {
                const progress = total > 0 ? ((loaded / total) * 100).toFixed(2) : '0.00'
                alertWait(`Loading local Backup... (${progress}%)`)
            })
            if (result.coldStorageFailed && result.coldStorageFailed > 0) {
                alertError(`Warning: ${result.coldStorageFailed} character(s) could not be restored from cold storage. The imported save may be incomplete. The app will now reload.`)
                await waitAlert()
            } else {
                alertStore.set({
                    type: "wait",
                    msg: "Success, Refreshing your app."
                });
            }
            location.search = ''
            location.reload()
        };

        input.click();
    } catch (error) {
        console.error(error);
        alertError('Failed, Is file corrupted?')
    }
}

// ── Server-side backup functions ─────────────────────────────────────────────

export async function SaveServerBackup(note = '') {
    try {
        alertWait(language.serverBackupSaving)
        const result = await forageStorage.saveServerBackup(note, (current, total, bytes) => {
            const pct = total > 0 ? ((current / total) * 100).toFixed(1) : '0'
            const bytesStr = formatBytes(bytes)
            alertWait(`${language.serverBackupSaving} (${pct}% - ${bytesStr})`)
        })
        notifySuccess(language.serverBackupSaveSuccess(result.filename, formatBytes(result.size)))
        return result
    } catch (error) {
        console.error(error)
        alertError(error instanceof Error ? error.message : 'Server backup failed')
        return null
    }
}

export async function SaveManualSnapshot(note = '') {
    try {
        alertWait(language.manualSnapshotSaving)
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
