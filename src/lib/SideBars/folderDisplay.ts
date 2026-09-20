import type { folder, FolderDisplayMode } from 'src/ts/storage/database.svelte'

export function folderDisplayMode(target: folder): FolderDisplayMode {
    return target.nodeOnlyDisplay ?? (target.imgFile ? 'image' : 'icon')
}
