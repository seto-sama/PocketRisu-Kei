import { language } from 'src/lang'
import { notifyError, notifySuccess, notifyInfo } from 'src/ts/alert'
import { forageStorage } from 'src/ts/storage/autoStorage'
import {
    buildInlayReference,
    getInlayInfosBatch,
    getInlayDownloadFileName,
} from 'src/ts/process/files/inlays'

const pendingDownloads = new Map<string, Promise<void>>()

export async function copyInlayReference(id: string): Promise<void> {
    try {
        await navigator.clipboard.writeText(buildInlayReference(id))
        notifySuccess(language.copied)
    } catch (error) {
        notifyError(`${error}`)
    }
}

export function downloadInlayAsset(id: string): Promise<void> {
    const pending = pendingDownloads.get(id)
    if (pending) return pending
    const task = (async () => {
        try {
            const asset = (await getInlayInfosBatch([id]))[id]
            await forageStorage.downloadAsset(`inlay/${id}`, asset
                ? getInlayDownloadFileName(asset.name, asset.ext)
                : undefined)
            notifyInfo(language.browserDownloadStarted)
        } catch (error) {
            notifyError(`${error}`)
        }
    })().finally(() => pendingDownloads.delete(id))
    pendingDownloads.set(id, task)
    return task
}
