import type { folder, FolderDisplayMode } from 'src/ts/storage/database.svelte'

export function folderDisplayMode(target: folder): FolderDisplayMode {
    return target.displayMode ?? (target.imgFile ? 'image' : 'icon')
}
