import { language } from 'src/lang'
import { notifyError, notifySuccess } from 'src/ts/alert'
import { downloadFile } from 'src/ts/globalApi.svelte'
import {
    buildInlayReference,
    getInlayAssetBlob,
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
            const asset = await getInlayAssetBlob(id)
            if (!asset) {
                notifyError(language.inlayGallery.inlayMissing)
                return
            }
            const bytes = new Uint8Array(await asset.data.arrayBuffer())
            await downloadFile(getInlayDownloadFileName(asset.name, asset.ext), bytes)
            notifySuccess(language.successExport)
        } catch (error) {
            notifyError(`${error}`)
        }
    })().finally(() => {
        if (pendingDownloads.get(id) === task) pendingDownloads.delete(id)
    })
    pendingDownloads.set(id, task)
    return task
}
