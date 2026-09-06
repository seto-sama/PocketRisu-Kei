<script lang="ts">
    import { FolderIcon, FolderOpenIcon } from '@lucide/svelte';
    import type { ComponentProps } from 'svelte';
    import type { folder as CharacterFolder } from 'src/ts/storage/database.svelte';
    import { DBState } from 'src/ts/stores.svelte';
    import { getCharImage } from 'src/ts/characters';
    import SidebarAvatar from './SidebarAvatar.svelte';
    import { folderDisplayMode } from './folderDisplay';
    import { folderIconComponent } from './folderIcons';
    import { SIDEBAR_ROOT_ITEM_SIZE } from './sidebarDrag';

    interface Props {
        folder: CharacterFolder;
        expanded?: boolean;
        size?: string;
        selected?: boolean;
        mergeTarget?: boolean;
        interactive?: boolean;
        showTooltip?: boolean;
        onClick?: () => void;
        oncontextmenu?: ComponentProps<typeof SidebarAvatar>['oncontextmenu'];
    }
    let { folder, expanded = false, size = String(SIDEBAR_ROOT_ITEM_SIZE), selected = false, mergeTarget = false, interactive = true, showTooltip = true, onClick, oncontextmenu }: Props = $props();
    const mode = $derived(folderDisplayMode(folder, DBState.db.showFolderName));
    const Icon = $derived(folderIconComponent(folder.nodeOnlyIcon) ?? (expanded ? FolderOpenIcon : FolderIcon));
</script>

<SidebarAvatar src="slot" {size} rounded={DBState.db.roundIcons} bordered name={folder.name} color={folder.color}
    backgroundimg={mode === 'image' && folder.imgFile ? getCharImage(folder.imgFile, 'plain') : ''}
    {selected} {mergeTarget} {interactive} {showTooltip} {onClick} {oncontextmenu}>
    {#if mode === 'name'}
        <span class="truncate px-[0.25em] font-bold leading-normal" style:font-size={`${Number(size) / SIDEBAR_ROOT_ITEM_SIZE}rem`}>{folder.name}</span>
    {:else}
        <Icon size={Number(size) * 0.4} />
    {/if}
</SidebarAvatar>
