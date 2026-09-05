import { language } from 'src/lang'
import { alertInput, alertSelect } from 'src/ts/alert'
import { getFileSrc, saveAsset } from 'src/ts/globalApi.svelte'
import { DBState } from 'src/ts/stores.svelte'
import type { folder } from 'src/ts/storage/database.svelte'
import { selectSingleFile } from 'src/ts/util'
import { folderColorOptions } from './folderColors'

export async function openSidebarFolderMenu(folderId: string) {
    const getFolder = () => DBState.db.characterOrder.find((entry): entry is folder =>
        typeof entry !== 'string' && entry.id === folderId)
    const initial = getFolder()
    if (!initial) return

    // Re-resolve at commit time: dialogs and uploads can outlive a reorder or
    // a database projection replacement. Only patch the requested fields.
    const apply = (patch: Partial<folder>) => {
        const current = getFolder()
        if (current) Object.assign(current, patch)
    }
    const localOnly = !initial.localOnly
    const selection = parseInt(await alertSelect([
        language.renameFolder,
        language.changeFolderColor,
        language.changeFolderImage,
        initial.localOnly ? language.showFolderOnRemoteAccess : language.hideFolderOnRemoteAccess,
        language.cancel,
    ]))
    switch (selection) {
        case 0: {
            const name = await alertInput(language.changeFolderName, [], initial.name)
            if (name) apply({ name })
            break
        }
        case 1: {
            const index = parseInt(await alertSelect(folderColorOptions.map(({ label }) => label)))
            const color = folderColorOptions[index]?.value
            if (color) apply({ color })
            break
        }
        case 2: {
            const imageSelection = parseInt(await alertSelect(['Reset to Default Image', 'Select Image File']))
            if (imageSelection === 0) {
                apply({ imgFile: null, img: '' })
            } else if (imageSelection === 1) {
                const file = await selectSingleFile(['png', 'jpg', 'webp'])
                if (!file || !getFolder()) return
                const imgFile = await saveAsset(file.data)
                const img = await getFileSrc(imgFile)
                apply({ imgFile, img })
            }
            break
        }
        case 3:
            apply({ localOnly })
            break
    }
}
