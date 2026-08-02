<script lang="ts">
    import type { Snippet } from "svelte";
    import { CircleQuestionMarkIcon, CopyIcon, DownloadIcon, FolderIcon, FolderPlusIcon, PencilIcon, SearchIcon, TrashIcon, XIcon } from "@lucide/svelte";
    import { language } from "src/lang";
    import { alertConfirm, alertInput } from "src/ts/alert";
    import { v4 as uuidv4 } from "uuid";
    import ShButton from "./GUI/ShButton.svelte";
    import ShTooltip from "./GUI/ShTooltip.svelte";
    import SettingLayout from "../Setting/Wrappers/SettingLayout.svelte";
    import ShSortableList from "./GUI/ShSortableList.svelte";
    import IconButton from "./GUI/IconButton.svelte";
    import IconButtonGroup from "./GUI/IconButtonGroup.svelte";

    interface PresetFolder {
        id: string;
        name: string;
    }

    interface Props {
        title: string;
        titleHelp?: string;
        folders: PresetFolder[];
        itemFolderIds: (string | undefined)[];
        itemDragDataKey: string;
        selectedFolder?: string;
        searchQuery?: string;
        close: () => void;
        configure?: () => void;
        configureLabel?: string;
        onFoldersChange: (folders: PresetFolder[]) => void;
        onAssignItem: (index: number, folderId: string | undefined) => void;
        onDeleteFolder: (folderId: string) => void;
        onFolderDragOver?: () => void;
        itemNames: string[];
        itemSearchTexts?: string[];
        searchPlaceholder?: string;
        readOnly?: boolean;
        visibleItemIndexes?: number[];
        emptyMessage?: string;
        selectedItemIndex?: number;
        itemEditMode?: boolean;
        onMoveItem?: (fromIndex: number, toIndex: number) => void;
        onSelectItem?: (index: number) => void;
        onDuplicateItem?: (index: number) => void;
        onExportItem?: (index: number) => void;
        onDeleteItem?: (index: number) => void;
        itemContent?: Snippet<[number]>;
        listFooter?: Snippet;
        children?: Snippet;
    }

    let {
        title,
        titleHelp,
        folders,
        itemFolderIds,
        itemDragDataKey,
        selectedFolder = $bindable('all'),
        searchQuery = $bindable(''),
        close,
        configure,
        configureLabel = language.edit,
        onFoldersChange,
        onAssignItem,
        onDeleteFolder,
        onFolderDragOver = () => {},
        itemNames,
        itemSearchTexts = itemNames,
        searchPlaceholder = language.presetSearch,
        readOnly = false,
        visibleItemIndexes = $bindable([]),
        emptyMessage = $bindable(''),
        selectedItemIndex = -1,
        itemEditMode = false,
        onMoveItem,
        onSelectItem,
        onDuplicateItem,
        onExportItem,
        onDeleteItem,
        itemContent,
        listFooter,
        children,
    }: Props = $props();

    let draggingFolderId = $state<string | null>(null);
    let itemDropTarget = $state<string | null>(null);
    const folderIds = $derived(new Set(folders.map(folder => folder.id)));
    const normalizedSearchQuery = $derived(searchQuery.trim().toLocaleLowerCase());

    // Keep the indexes exposed to the parent in sync before Svelte updates the
    // list DOM. A normal post-render effect leaves one frame where a deleted
    // item's old index can still be rendered by preset pickers.
    $effect.pre(() => {
        visibleItemIndexes = itemNames
            .map((_, index) => index)
            .filter(index => {
                const folderId = itemFolderIds[index];
                const inFolder = selectedFolder === 'all'
                    || (selectedFolder === 'uncategorized'
                        ? !folderId || !folderIds.has(folderId)
                        : folderId === selectedFolder);
                return inFolder && (!normalizedSearchQuery
                    || (itemSearchTexts[index] ?? itemNames[index] ?? '').toLocaleLowerCase().includes(normalizedSearchQuery));
            });
        emptyMessage = normalizedSearchQuery ? language.presetNoSearchResults : language.presetFolderEmpty;
    });

    function folderCount(id: string) {
        if (id === 'all') return itemFolderIds.length;
        if (id === 'uncategorized') return itemFolderIds.filter(folderId => !folderId || !folderIds.has(folderId)).length;
        return itemFolderIds.filter(folderId => folderId === id).length;
    }

    async function createFolder() {
        const name = (await alertInput(language.presetFolderNamePrompt))?.trim();
        if (!name) return;
        const id = uuidv4();
        onFoldersChange([...folders, { id, name }]);
        selectedFolder = id;
    }

    async function renameFolder(id: string, oldName: string) {
        const name = (await alertInput(language.presetFolderRenamePrompt, [], oldName))?.trim();
        if (name) onFoldersChange(folders.map(folder => folder.id === id ? { ...folder, name } : folder));
    }

    async function deleteFolder(id: string) {
        if (!await alertConfirm(language.presetFolderDeleteConfirm)) return;
        onDeleteFolder(id);
        onFoldersChange(folders.filter(folder => folder.id !== id));
        if (selectedFolder === id) selectedFolder = 'all';
    }

    function dropOnFolder(folderId: string, e: DragEvent) {
        if (readOnly) return;
        e.preventDefault();
        e.stopPropagation();
        if (draggingFolderId) return;
        const rawIndex = e.dataTransfer?.getData(itemDragDataKey);
        const index = rawIndex ? Number(rawIndex) : -1;
        if (Number.isInteger(index) && index >= 0) {
            onAssignItem(index, folderId === 'all' || folderId === 'uncategorized' ? undefined : folderId);
        }
        itemDropTarget = null;
    }

    function dragItemOverFolder(folderId: string, e: DragEvent) {
        if (readOnly) return;
        e.preventDefault();
        e.stopPropagation();
        onFolderDragOver();
        if (!draggingFolderId) itemDropTarget = folderId;
    }

    function reorderItems(orderedKeys: string[], draggedKey: string) {
        if (readOnly) return;
        const source = Number(draggedKey);
        const newPosition = orderedKeys.indexOf(draggedKey);
        const nextKey = orderedKeys[newPosition + 1];
        const target = nextKey === undefined ? itemNames.length : Number(nextKey);
        if (Number.isInteger(source) && Number.isInteger(target)) onMoveItem?.(source, target);
    }
</script>

<!-- svelte-ignore a11y_click_events_have_key_events -->
<div class="fixed inset-0 z-50 bg-black/50 flex justify-center items-center" role="button" tabindex="0" onclick={close}>
<div
    class="bg-darkbg break-any rounded-md flex flex-col w-[min(56rem,calc(100%-1rem))] h-[min(44rem,calc(100%-1rem))] overflow-hidden border border-darkborderc"
    role="button"
    tabindex="0"
    onclick={(e) => e.stopPropagation()}
>
    <div class="p-4 pb-0">
        <div class="flex items-center text-textcolor mb-4">
            <h2 class="mt-0 mb-0">{title}</h2>
            {#if titleHelp}
                <ShTooltip>
                    {#snippet trigger(props)}
                        <button
                            {...props}
                            class="ml-1 inline-flex size-5 shrink-0 items-center justify-center text-textcolor2 cursor-help hover:text-primary"
                            aria-label={`${title} ${language.showHelp}`}
                        >
                            <CircleQuestionMarkIcon size={12}/>
                        </button>
                    {/snippet}
                    {titleHelp}
                </ShTooltip>
            {/if}
            <div class="grow flex justify-end">
                <IconButton size="lg" onclick={close}><XIcon /></IconButton>
            </div>
        </div>
    </div>

    <div class="flex min-h-0 grow border-t border-darkborderc max-sm:flex-col">
        <aside class="w-48 shrink-0 border-r border-darkborderc p-2 flex flex-col min-h-0 max-sm:w-full max-sm:h-44 max-sm:border-r-0 max-sm:border-b">
            <div class="min-h-0 grow overflow-y-auto">
                <div class="flex flex-col gap-1">
                    {#each [
                        { id: 'all', name: language.presetAll },
                        { id: 'uncategorized', name: language.presetUncategorized },
                    ] as folder}
                        <button class="w-full flex items-center gap-2 rounded-md px-2 py-2 text-sm text-textcolor {selectedFolder === folder.id ? '' : 'hover:bg-selected/30'}"
                            class:bg-selected={selectedFolder === folder.id}
                            class:folder-drop-target={itemDropTarget === folder.id}
                            ondragover={(e) => dragItemOverFolder(folder.id, e)}
                            ondragleave={() => { itemDropTarget = null }}
                            ondrop={(e) => dropOnFolder(folder.id, e)}
                            onclick={() => selectedFolder = folder.id}>
                            <FolderIcon size={18}/><span class="truncate grow text-left">{folder.name}</span>
                            <span class="text-xs text-textcolor2">{folderCount(folder.id)}</span>
                        </button>
                    {/each}
                </div>
                <div class="my-3 border-t border-darkborderc"></div>
                <ShSortableList
                    className="flex flex-col gap-1"
                    disabled={readOnly}
                    dataTransferKey="presetFolderId"
                    onReorder={(orderedIds) => {
                        const byId = new Map(folders.map(folder => [folder.id, folder]));
                        onFoldersChange(orderedIds.map(id => byId.get(id)).filter((folder): folder is PresetFolder => !!folder));
                    }}
                    onDragStart={(id) => { draggingFolderId = id }}
                    onDragEnd={() => { draggingFolderId = null }}
                >
                {#each folders as folder (folder.id)}
                    <div class="group w-full h-10 flex items-center gap-2 rounded-md px-2 py-2 text-sm text-textcolor {selectedFolder === folder.id ? '' : 'hover:bg-selected/30'}"
                        data-sortable-key={folder.id}
                        data-sortable-no-scale
                        class:bg-selected={selectedFolder === folder.id}
                        class:folder-drop-target={itemDropTarget === folder.id}
                        role="button" tabindex="0"
                        ondragover={(e) => {
                            if (!draggingFolderId) dragItemOverFolder(folder.id, e);
                        }}
                        ondragleave={() => { if (!draggingFolderId) itemDropTarget = null }}
                        ondrop={(e) => { if (!draggingFolderId) dropOnFolder(folder.id, e) }}
                        onclick={() => selectedFolder = folder.id}
                        onkeydown={(e) => { if (e.key === 'Enter') selectedFolder = folder.id }}>
                        <FolderIcon size={18}/><span class="truncate grow">{folder.name}</span>
                        {#if !readOnly}
                            <span class="text-xs text-textcolor2 group-hover:hidden">{folderCount(folder.id)}</span>
                            <IconButtonGroup size="sm" className="no-sort hidden shrink-0 group-hover:flex">
                                <IconButton
                                    onclick={(e) => { e.stopPropagation(); renameFolder(folder.id, folder.name) }}
                                >
                                    <PencilIcon />
                                </IconButton>
                                <IconButton
                                    tone="destructive"
                                    onclick={(e) => { e.stopPropagation(); deleteFolder(folder.id) }}
                                >
                                    <TrashIcon />
                                </IconButton>
                            </IconButtonGroup>
                        {:else}
                            <span class="text-xs text-textcolor2">{folderCount(folder.id)}</span>
                        {/if}
                    </div>
                {/each}
                </ShSortableList>
            </div>
            {#if !readOnly}
                <button class="shrink-0 mt-2 w-full flex items-center gap-2 rounded-md px-2 py-2 text-sm text-textcolor2 hover:text-primary hover:bg-selected/30" onclick={createFolder}>
                    <FolderPlusIcon size={18}/><span>{language.presetNewFolder}</span>
                </button>
            {/if}
        </aside>
        <section class="min-w-0 min-h-0 grow flex flex-col p-3">
            <SettingLayout variant="search" className="mb-2">
                <div class="flex items-center gap-2 border border-darkborderc rounded-md px-3 focus-within:border-primary">
                    <SearchIcon size={18} class="text-textcolor2 shrink-0"/>
                    <input bind:value={searchQuery} placeholder={searchPlaceholder}
                        class="w-full py-2 bg-transparent text-textcolor outline-none"/>
                </div>
            </SettingLayout>
            {#if itemContent && onSelectItem}
                <ShSortableList
                    className="grow min-h-0 overflow-y-auto flex flex-col gap-1 [&>*]:shrink-0"
                    disabled={readOnly || !onMoveItem || itemEditMode}
                    dataTransferKey={itemDragDataKey}
                    dragPreviewText={(key) => itemNames[Number(key)] || 'Unnamed Preset'}
                    onReorder={(orderedKeys, event) => reorderItems(orderedKeys, event.item.getAttribute('data-sortable-key') ?? '')}
                    onDragEnd={() => { itemDropTarget = null }}
                >
                    {#each visibleItemIndexes as index (index)}
                        <div role="button" tabindex={itemEditMode ? -1 : 0}
                            data-sortable-key={String(index)}
                            data-sortable-no-scale
                            class="preset-picker-item w-full h-10 min-w-0 flex items-center rounded-md text-left text-textcolor px-2 {index === selectedItemIndex ? '' : 'hover:bg-selected/30'}"
                            class:bg-selected={index === selectedItemIndex}
                            class:cursor-grab={!readOnly && !!onMoveItem && !itemEditMode}
                            onclick={() => { if (!itemEditMode) onSelectItem(index) }}
                            onkeydown={(e) => { if (!itemEditMode && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); onSelectItem(index) } }}>
                            {@render itemContent(index)}
                            {#if !readOnly && (onDuplicateItem || onExportItem || onDeleteItem)}
                                <IconButtonGroup className="no-sort ml-3 shrink-0">
                                    {#if onDuplicateItem}<IconButton onclick={(e) => { e.stopPropagation(); onDuplicateItem(index) }}><CopyIcon /></IconButton>{/if}
                                    {#if onExportItem}<IconButton onclick={(e) => { e.stopPropagation(); onExportItem(index) }}><DownloadIcon /></IconButton>{/if}
                                    {#if onDeleteItem}<IconButton tone="destructive" onclick={(e) => { e.stopPropagation(); onDeleteItem(index) }}><TrashIcon /></IconButton>{/if}
                                </IconButtonGroup>
                            {/if}
                        </div>
                    {:else}
                        <div class="h-full min-h-32 flex items-center justify-center text-textcolor2 text-sm">{emptyMessage}</div>
                    {/each}
                    {@render listFooter?.()}
                </ShSortableList>
            {/if}
            {@render children?.()}
            {#if configure}
                <div class="shrink-0 flex justify-start pt-2 max-sm:hidden">
                    <ShButton variant="primary" size="sm" onclick={configure}>{configureLabel}</ShButton>
                </div>
            {/if}
        </section>
    </div>
</div>
</div>

<style>
    /* CSS draws text-overflow ellipses using the truncating element's own
       color. When an item combines a primary label with secondary details,
       keep the label primary but make the generated ellipsis secondary too. */
    .preset-picker-item :global(.truncate:has(> .text-textcolor2)) {
        color: var(--risu-theme-textcolor2);
    }

    .preset-picker-item :global(.truncate:has(> .text-textcolor2) > :not(.text-textcolor2):not(.isModuleGlobal)) {
        color: var(--risu-theme-textcolor);
    }

    .folder-drop-target {
        background: color-mix(in srgb, var(--risu-theme-selected) 50%, transparent);
        box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--risu-theme-selected) 70%, transparent);
    }
</style>
