<script lang="ts">
    import { FolderIcon, FolderOpenIcon } from '@lucide/svelte';
    import type { ComponentProps } from 'svelte';
    import type { ChatFolder, folder as CharacterFolder } from 'src/ts/storage/database.svelte';
    import { DBState } from 'src/ts/stores.svelte';
    import { getCharImage } from 'src/ts/characters';
    import SidebarAvatar from './SidebarAvatar.svelte';
    import { folderDisplayMode } from './folderDisplay';
    import { folderIconComponent } from './folderIcons';
    import { SIDEBAR_ROOT_ITEM_SIZE } from './sidebarDrag';

    type FolderAvatarData = CharacterFolder | ChatFolder;

    interface Props {
        folder: FolderAvatarData;
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
    const characterFolder = $derived('data' in folder ? folder : undefined);
    const mode = $derived(characterFolder ? folderDisplayMode(characterFolder, DBState.db.showFolderName) : 'icon');
    const Icon = $derived(folderIconComponent(folder.nodeOnlyIcon) ?? (expanded ? FolderOpenIcon : FolderIcon));
    const folderImage = $derived(characterFolder?.imgFile);
    const backgroundImage = $derived(mode === 'image' && folderImage ? getCharImage(folderImage, 'plain') : '');
    const folderName = $derived(folder.name ?? '');
</script>

<SidebarAvatar src="slot" {size} rounded={DBState.db.roundIcons} bordered name={folderName} color={folder.color}
    backgroundimg={backgroundImage}
    {selected} {mergeTarget} {interactive} {showTooltip} {onClick} {oncontextmenu}>
    {#if mode === 'name'}
        <span class="truncate px-[0.25em] font-bold leading-normal" style:font-size={`${Number(size) / SIDEBAR_ROOT_ITEM_SIZE}rem`}>{folderName}</span>
    {:else}
        <Icon size={Number(size) * 0.4} />
    {/if}
</SidebarAvatar>
