import { language } from 'src/lang'
import { alertStore, notifySuccess } from '../alert'
import { downloadFile } from '../download'

type PresetExportData = Parameters<typeof downloadFile>[1]

export function showExportAssetProgress(completed: number, total: number): void {
    if (total === 0) return
    alertStore.set({
        type: 'progress',
        title: language.export,
        msg: language.exportAssetsPreparing,
        submsg: String(completed / total * 100),
        progressDetail: `${completed.toLocaleString()} / ${total.toLocaleString()}`,
    })
}

export async function exportPresetFile(
    name: string,
    data: PresetExportData | Promise<PresetExportData>,
    successMessage: unknown = language.browserDownloadStarted,
): Promise<void> {
    await downloadFile(name, await data)
    notifySuccess(successMessage)
}
