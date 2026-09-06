import type { folder, FolderDisplayMode } from 'src/ts/storage/database.svelte'

export function folderDisplayMode(target: folder, showFolderName: boolean): FolderDisplayMode {
    return target.nodeOnlyDisplay ?? (target.imgFile ? 'image' : showFolderName ? 'name' : 'icon')
}

