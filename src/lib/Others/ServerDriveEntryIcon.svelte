<script lang="ts">
    import { FileIcon, FileJsonIcon, FolderIcon, ImageIcon, PuzzleIcon, SlidersHorizontalIcon, UserRoundIcon } from '@lucide/svelte'
    import { getFileType } from '../../../shared/fileTypes.mjs'
    import type { DriveEntry } from 'src/ts/storage/nodeStorage'

    let { entry, thumbnailUrl = '', strokeWidth = 1.5 }: {
        entry: DriveEntry
        thumbnailUrl?: string
        strokeWidth?: number
    } = $props()
    let failedUrl = $state('')
    const icons = { image: ImageIcon, character: UserRoundIcon, preset: SlidersHorizontalIcon, module: PuzzleIcon, json: FileJsonIcon, file: FileIcon }
    const Icon = $derived(entry.type === 'directory' ? FolderIcon : icons[getFileType(entry.name)])
</script>

<span class="flex size-12 shrink-0 items-center justify-center" aria-hidden="true">
    {#if thumbnailUrl && failedUrl !== thumbnailUrl}
        <img src={thumbnailUrl} alt="" loading="lazy" decoding="async" draggable={false}
            class="pointer-events-none size-full rounded-md object-contain"
            onerror={event => { failedUrl = event.currentTarget.getAttribute('src') }} />
    {:else}
        <Icon size={32} {strokeWidth} absoluteStrokeWidth class={entry.type === 'directory' ? 'shrink-0 text-warning fill-warning/10' : 'shrink-0 text-primary'} />
    {/if}
</span>
