<script lang="ts">
    import EmptyState from "src/lib/UI/components/EmptyState.svelte";
    import type { ComponentProps, Snippet } from "svelte";
    import { CopyIcon, DownloadIcon, FolderIcon, FolderPlusIcon, PackageIcon, PencilIcon, SearchIcon, SettingsIcon, TagIcon, TagsIcon, TrashIcon, XIcon } from "@lucide/svelte";
    import { language } from "src/lang";
    import { alertConfirm, alertConfirmMulti, alertInput } from "src/ts/alert";
    import { createEntityId } from 'src/ts/id';
    import Help from "../Others/Help.svelte";
    import SettingLayout from "../Setting/Wrappers/SettingLayout.svelte";
    import SortableList, { restoreSortableDragOrigin, type SortableDragOrigin } from "./components/SortableList.svelte";
    import IconButton from "./components/IconButton.svelte";
    import IconButtonGroup from "./components/IconButtonGroup.svelte";
    import ListActionBar from "./components/ListActionBar.svelte";
    import OverlayPortal from "./components/overlay/OverlayPortal.svelte";
    import InlineRenameAction from "./components/InlineRenameAction.svelte";
    import { InlineEditableNameController } from "./components/InlineEditableNameController.svelte";
    import { isEventFromInteractiveChild } from "src/lib/utils";

    interface PresetFolder {
        id: string;
        name: string;
        depth?: number;
        kind?: 'folder' | 'module';
        sortable?: boolean;
    }

    interface Props {
        title: string;
        titleHelpKey?: keyof typeof language.help;
        folders: PresetFolder[];
        itemFolderIds: (string | string[] | undefined)[];
        itemDragDataKey: string;
        selectedFolder?: string;
        searchQuery?: string;
        close: () => void;
        configure?: () => void;
        onFoldersChange: (folders: PresetFolder[]) => void;
        onMoveFolder?: (orderedIds: string[], draggedId: string) => void;
        onAssignItem: (index: number, folderId: string | undefined) => void;
        onDeleteFolder: (folderId: string) => void;
        onFolderDragOver?: () => void;
        itemNames: string[];
        itemSearchTexts?: string[];
        searchPlaceholder?: string;
        organizationKind?: 'folder' | 'tag';
        folderReadOnly?: boolean;
        folderReorderable?: boolean;
        folderEditable?: boolean;
        itemRenameable?: boolean;
        allowItemDropOnReadOnlyFolders?: boolean;
        visibleItemIndexes?: number[];
        emptyMessage?: string;
        folderEmptyMessage?: string;
        folderEmptySize?: ComponentProps<typeof EmptyState>['size'];
        folderNamePrompt?: string;
        folderRenamePrompt?: string;
        folderDeleteConfirm?: string;
        newFolderLabel?: string;
        showCreateFolder?: boolean;
        createFolderDisabled?: boolean;
        showUncategorized?: boolean;
        onCreateFolder?: (name: string) => string | void;
        sidebarFooterActions?: Snippet;
        allowFolderAssignmentDrag?: boolean;
        allowItemReorder?: boolean;
        selectedItemIndex?: number;
        onMoveItem?: (fromIndex: number, toIndex: number) => void;
        onSelectItem?: (index: number) => void;
        onDuplicateItem?: (index: number) => void;
        onExportItem?: (index: number) => void;
        onDeleteItem?: (index: number) => void;
        itemDeleteLabel?: string;
        showDuplicateItem?: (index: number) => boolean;
        showExportItem?: (index: number) => boolean;
        itemContent?: Snippet<[number, InlineEditableNameController]>;
        itemActions?: Snippet<[number]>;
        listFooter?: Snippet;
        onSelectNone?: () => void;
        noneSelected?: boolean;
        noneLabel?: string;
        children?: Snippet;
    }

    let {
        title,
        titleHelpKey,
        folders,
        itemFolderIds,
        itemDragDataKey,
        selectedFolder = $bindable('all'),
        searchQuery = $bindable(''),
        close,
        configure,
        onFoldersChange,
        onMoveFolder,
        onAssignItem,
        onDeleteFolder,
        onFolderDragOver = () => {},
        itemNames,
        itemSearchTexts = itemNames,
        searchPlaceholder = language.presetSearch,
        organizationKind = 'folder',
        folderReadOnly = false,
        folderReorderable = !folderReadOnly,
        folderEditable = !folderReadOnly,
        itemRenameable = false,
        allowItemDropOnReadOnlyFolders = false,
        visibleItemIndexes = $bindable([]),
        emptyMessage = $bindable(''),
        folderEmptyMessage = organizationKind === 'tag' ? language.presetTagEmpty : language.presetFolderEmpty,
        folderEmptySize = 'default',
        folderNamePrompt = organizationKind === 'tag' ? language.presetTagNamePrompt : language.presetFolderNamePrompt,
        folderRenamePrompt = organizationKind === 'tag' ? language.presetTagRenamePrompt : language.presetFolderRenamePrompt,
        folderDeleteConfirm = organizationKind === 'tag' ? language.presetTagDeleteConfirm : language.presetFolderDeleteConfirm,
        newFolderLabel = organizationKind === 'tag' ? language.presetNewTag : language.presetNewFolder,
        showCreateFolder = true,
        createFolderDisabled = false,
        showUncategorized = true,
        onCreateFolder,
        sidebarFooterActions,
        allowFolderAssignmentDrag = false,
        allowItemReorder = true,
        selectedItemIndex = -1,
        onMoveItem,
        onSelectItem,
        onDuplicateItem,
        onExportItem,
        onDeleteItem,
        itemDeleteLabel = language.presetDeleteAction,
        showDuplicateItem = () => true,
        showExportItem = () => true,
        itemContent,
        itemActions,
        listFooter,
        onSelectNone,
        noneSelected = false,
        noneLabel = language.bindingNone,
        children,
    }: Props = $props();

    let draggingFolderId = $state<string | null>(null);
    let itemDropTarget = $state<string | null>(null);
    let itemDroppedOnFolder = false;
    let itemDragOrigin: SortableDragOrigin | null = null;
    const folderIds = $derived(new Set(folders.map(folder => folder.id)));
    const normalizedSearchQuery = $derived(searchQuery.trim().toLocaleLowerCase());
    const showNoneOption = $derived(!!onSelectNone
        && (selectedFolder === 'all' || selectedFolder === 'uncategorized') && (
        !normalizedSearchQuery || noneLabel.toLocaleLowerCase().includes(normalizedSearchQuery)
    ));

    function itemHasFolder(value: string | string[] | undefined, folderId: string): boolean {
        return Array.isArray(value) ? value.includes(folderId) : value === folderId;
    }

    function itemIsUncategorized(value: string | string[] | undefined): boolean {
        if (Array.isArray(value)) return value.length === 0 || !value.some(id => folderIds.has(id));
        return !value || !folderIds.has(value);
    }

    const folderCounts = $derived.by(() => {
        const counts = new Map<string, number>([['all', itemFolderIds.length], ['uncategorized', 0]]);
        for (const value of itemFolderIds) {
            if (itemIsUncategorized(value)) counts.set('uncategorized', (counts.get('uncategorized') ?? 0) + 1);
            const assignedIds = Array.isArray(value) ? new Set(value) : value ? [value] : [];
            for (const id of assignedIds) {
                if (folderIds.has(id)) counts.set(id, (counts.get(id) ?? 0) + 1);
            }
        }
        return counts;
    });

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
                        ? itemIsUncategorized(folderId)
                        : itemHasFolder(folderId, selectedFolder));
                return inFolder && (!normalizedSearchQuery
                    || (itemSearchTexts[index] ?? itemNames[index] ?? '').toLocaleLowerCase().includes(normalizedSearchQuery));
            });
        emptyMessage = normalizedSearchQuery ? language.noSearchResults : folderEmptyMessage;
    });

    function folderCount(id: string) {
        return folderCounts.get(id) ?? 0;
    }

    async function createFolder() {
        const name = (await alertInput(folderNamePrompt))?.trim();
        if (!name) return;
        if (onCreateFolder) {
            const id = onCreateFolder(name);
            if (id) selectedFolder = id;
            return;
        }
        const id = createEntityId();
        onFoldersChange([...folders, { id, name }]);
        selectedFolder = id;
    }

    async function renameFolder(id: string, oldName: string) {
        const name = (await alertInput(folderRenamePrompt, [], oldName))?.trim();
        if (name) onFoldersChange(folders.map(folder => folder.id === id ? { ...folder, name } : folder));
    }

    async function deleteFolder(id: string) {
        if (!await alertConfirm(folderDeleteConfirm)) return;
        onDeleteFolder(id);
        onFoldersChange(folders.filter(folder => folder.id !== id));
        if (selectedFolder === id) selectedFolder = 'all';
    }

    async function deleteItem(index: number) {
        if (!onDeleteItem) return;
        if (organizationKind !== 'tag') {
            onDeleteItem(index);
            return;
        }
        if (selectedFolder === 'uncategorized') {
            onDeleteItem(index);
            return;
        }
        const removeLabel = selectedFolder === 'all'
            ? language.presetRemoveAllTagsAction
            : language.presetRemoveTagAction.replace(
                '{}',
                folders.find(folder => folder.id === selectedFolder)?.name ?? selectedFolder,
            );
        const selected = await alertConfirmMulti(
            language.presetItemDeletePrompt.replace('{}', itemNames[index] ?? ''),
            [removeLabel, { label: itemDeleteLabel, variant: 'destructive' }],
        );
        if (selected === 0) {
            onAssignItem(index, selectedFolder === 'all' ? undefined : selectedFolder);
        }
        else if (selected === 1) {
            onDeleteItem(index);
        }
    }

    function dropOnFolder(folderId: string, e: DragEvent) {
        if (folderReadOnly && !allowItemDropOnReadOnlyFolders) return;
        e.preventDefault();
        e.stopPropagation();
        if (draggingFolderId) return;
        const rawIndex = e.dataTransfer?.getData(itemDragDataKey);
        const index = rawIndex ? Number(rawIndex) : -1;
        if (Number.isInteger(index) && index >= 0) {
            itemDroppedOnFolder = true;
            const assignmentId = folderId === 'all' || folderId === 'uncategorized'
                ? undefined
                : folderId;
            if (organizationKind !== 'tag'
                || !assignmentId
                || !itemHasFolder(itemFolderIds[index], assignmentId)) {
                onAssignItem(index, assignmentId);
            }
        }
        itemDropTarget = null;
    }

    function restoreItemDragPosition() {
        restoreSortableDragOrigin(itemDragOrigin);
    }

    function dragItemOverFolder(folderId: string, e: DragEvent) {
        if (folderReadOnly && !allowItemDropOnReadOnlyFolders) return;
        e.preventDefault();
        e.stopPropagation();
        restoreItemDragPosition();
        onFolderDragOver();
        if (!draggingFolderId) itemDropTarget = folderId;
    }

    function reorderItems(orderedKeys: string[], draggedKey: string) {
        if (!allowItemReorder || !onMoveItem) {
            restoreItemDragPosition();
            return;
        }
        const source = Number(draggedKey);
        const newPosition = orderedKeys.indexOf(draggedKey);
        const nextKey = orderedKeys[newPosition + 1];
        const target = nextKey === undefined ? itemNames.length : Number(nextKey);
        if (Number.isInteger(source) && Number.isInteger(target)) onMoveItem?.(source, target);
    }
</script>

<!-- svelte-ignore a11y_click_events_have_key_events -->
<OverlayPortal onEscape={close}>
<div class="risu-modal-backdrop risu-layer-overlay pointer-events-auto flex justify-center items-center" role="button" tabindex="0" onclick={close}>
<div
    class="bg-darkbg break-any rounded-md flex flex-col w-[min(56rem,calc(100%-1rem))] h-[min(44rem,calc(100%-1rem))] overflow-hidden border border-darkborderc"
    role="button"
    tabindex="0"
    onclick={(e) => e.stopPropagation()}
>
    <div class="p-4 pb-0">
        <div class="flex items-center text-maintext mb-4">
            <h2 class="mt-0 mb-0">{title}</h2>
            {#if titleHelpKey}<Help key={titleHelpKey} name={title} />{/if}
            <div class="grow flex justify-end">
                {#if configure}
                    <IconButton size="lg" onclick={configure} title={language.settings} aria-label={language.settings}>
                        <SettingsIcon />
                    </IconButton>
                {/if}
                <IconButton size="lg" onclick={close}><XIcon /></IconButton>
            </div>
        </div>
    </div>

    <div class="flex min-h-0 grow border-t border-darkborderc max-sm:flex-col">
        <aside
            class="w-48 shrink-0 border-r border-darkborderc p-2 flex flex-col min-h-0 max-sm:w-full max-sm:h-44 max-sm:border-r-0 max-sm:border-b"
            ondragover={() => {
                if (!draggingFolderId) restoreItemDragPosition();
            }}
        >
            <div class="min-h-0 grow overflow-y-auto">
                <div class="flex flex-col gap-1">
                    {#each [
                        { id: 'all', name: language.presetAll },
                        ...(showUncategorized ? [{
                            id: 'uncategorized',
                            name: organizationKind === 'tag' ? language.presetUntagged : language.presetUncategorized,
                        }] : []),
                    ] as folder}
                        <button class="risu-selectable-row w-full h-9 flex items-center gap-2 rounded-md px-2 py-2 text-sm text-maintext"
                            data-selected={selectedFolder === folder.id}
                            class:folder-drop-target={itemDropTarget === folder.id}
                            ondragover={(e) => dragItemOverFolder(folder.id, e)}
                            ondragleave={() => { itemDropTarget = null }}
                            ondrop={(e) => dropOnFolder(folder.id, e)}
                            onclick={() => selectedFolder = folder.id}>
                            {#if organizationKind === 'tag'}
                                {#if folder.id === 'all'}<TagsIcon size={18} class="shrink-0"/>{:else}<TagIcon size={18} class="shrink-0"/>{/if}
                            {:else}
                                <FolderIcon size={18} class="shrink-0"/>
                            {/if}
                            <span class="truncate grow text-left">{folder.name}</span>
                            <span class="text-xs text-subtext">{folderCount(folder.id)}</span>
                        </button>
                    {/each}
                </div>
                <div class="my-3 border-t border-darkborderc"></div>
                <SortableList
                    className="flex flex-col gap-1"
                    disabled={!folderReorderable}
                    dataTransferKey="presetFolderId"
                    onReorder={(orderedIds, event) => {
                        const draggedId = event.item.getAttribute('data-sortable-key') ?? '';
                        if (onMoveFolder) {
                            onMoveFolder(orderedIds, draggedId);
                            return;
                        }
                        const byId = new Map(folders.map(folder => [folder.id, folder]));
                        onFoldersChange(orderedIds.map(id => byId.get(id)).filter((folder): folder is PresetFolder => !!folder));
                    }}
                    onDragStart={(id) => { draggingFolderId = id }}
                    onDragEnd={() => { draggingFolderId = null }}
                >
                {#each folders as folder (folder.id)}
                    <div class="risu-selectable-row group w-full h-9 flex items-center gap-2 rounded-md px-2 py-2 text-sm text-maintext"
                        data-sortable-key={folder.sortable === false ? undefined : folder.id}
                        data-sortable-no-scale
                        data-selected={selectedFolder === folder.id}
                        style:padding-left={`${8 + (folder.depth ?? 0) * 16}px`}
                        class:folder-drop-target={itemDropTarget === folder.id}
                        role="button" tabindex="0"
                        ondragover={(e) => {
                            if (!draggingFolderId) dragItemOverFolder(folder.id, e);
                        }}
                        ondragleave={() => { if (!draggingFolderId) itemDropTarget = null }}
                        ondrop={(e) => { if (!draggingFolderId) dropOnFolder(folder.id, e) }}
                        onclick={() => selectedFolder = folder.id}
                        onkeydown={(e) => {
                            if (!isEventFromInteractiveChild(e) && e.key === 'Enter') selectedFolder = folder.id
                        }}>
                        {#if folder.kind === 'module'}
                            <PackageIcon size={18} class="shrink-0"/>
                        {:else if organizationKind === 'tag'}
                            <TagIcon size={18} class="shrink-0"/>
                        {:else}
                            <FolderIcon size={18} class="shrink-0"/>
                        {/if}<span class="truncate grow">{folder.name}</span>
                        {#if folderEditable}
                            <span class="text-xs text-subtext group-hover:hidden">{folderCount(folder.id)}</span>
                            <IconButtonGroup size="sm" className="no-sort hidden shrink-0 group-hover:flex">
                                <IconButton
                                    title={folderRenamePrompt}
                                    aria-label={folderRenamePrompt}
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
                            <span class="text-xs text-subtext">{folderCount(folder.id)}</span>
                        {/if}
                    </div>
                {/each}
                </SortableList>
            </div>
            {#if showCreateFolder || sidebarFooterActions}
                <ListActionBar mode="inline" className="shrink-0 gap-1">
                    {#if showCreateFolder}
                        <button
                            class="min-w-0 grow flex items-center gap-2 rounded-md px-2 py-2 text-sm text-subtext risu-interactive-accent risu-interactive-surface"
                            class:opacity-50={createFolderDisabled}
                            disabled={createFolderDisabled}
                            onclick={createFolder}
                        >
                            {#if organizationKind === 'tag'}<TagIcon size={18}/>{:else}<FolderPlusIcon size={18}/>{/if}<span class="truncate">{newFolderLabel}</span>
                        </button>
                    {/if}
                    {@render sidebarFooterActions?.()}
                </ListActionBar>
            {/if}
        </aside>
        <section class="min-w-0 min-h-0 grow flex flex-col px-2 py-3">
            <SettingLayout variant="search" className="mb-2">
                <div class="risu-field-border flex items-center gap-2 rounded-md px-2.5">
                    <SearchIcon size={18} class="text-subtext shrink-0"/>
                    <input bind:value={searchQuery} placeholder={searchPlaceholder}
                        class="w-full py-2 bg-transparent text-maintext outline-none"/>
                </div>
            </SettingLayout>
            {#if itemContent && onSelectItem}
                <SortableList
                    className="relative grow min-h-0 overflow-y-auto flex flex-col gap-1 [&>*]:shrink-0"
                    disabled={!onMoveItem && !allowFolderAssignmentDrag}
                    dataTransferKey={itemDragDataKey}
                    dragPreviewText={(key) => itemNames[Number(key)] || 'Unnamed Preset'}
                    onReorder={(orderedKeys, event) => {
                        if (!itemDroppedOnFolder) reorderItems(orderedKeys, event.item.getAttribute('data-sortable-key') ?? '');
                    }}
                    onDragStart={(_key, event) => {
                        itemDroppedOnFolder = false;
                        itemDragOrigin = {
                            item: event.item,
                            parent: event.from,
                            nextSibling: event.item.nextSibling,
                        };
                    }}
                    onDragEnd={() => {
                        itemDropTarget = null;
                        itemDroppedOnFolder = false;
                        itemDragOrigin = null;
                    }}
                >
                    {#each visibleItemIndexes as index (index)}
                        {@const renameController = new InlineEditableNameController()}
                        <div role="button" tabindex="0"
                            data-sortable-key={String(index)}
                            data-sortable-no-scale
                            data-inline-rename-row={itemRenameable ? '' : undefined}
                            class="risu-selectable-row preset-picker-item w-full h-9 min-w-0 flex items-center rounded-md text-left text-maintext px-2"
                            data-selected={index === selectedItemIndex}
                            class:cursor-grab={!!onMoveItem || allowFolderAssignmentDrag}
                            onclick={() => onSelectItem(index)}
                            onkeydown={(e) => {
                                if (isEventFromInteractiveChild(e)) return
                                if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelectItem(index) }
                            }}>
                            {@render itemContent(index, renameController)}
                            {#if itemRenameable || itemActions || onDuplicateItem || onExportItem || onDeleteItem}
                                <IconButtonGroup className="ml-3 self-stretch shrink-0" onclick={(e) => e.stopPropagation()}>
                                    {#if itemRenameable}<InlineRenameAction controller={renameController} />{/if}
                                    {@render itemActions?.(index)}
                                    {#if onDuplicateItem && showDuplicateItem(index)}<IconButton title={language.presetDuplicate} aria-label={language.presetDuplicate} onclick={() => onDuplicateItem(index)}><CopyIcon /></IconButton>{/if}
                                    {#if onExportItem && showExportItem(index)}<IconButton title={language.presetExport} aria-label={language.presetExport} onclick={() => onExportItem(index)}><DownloadIcon /></IconButton>{/if}
                                    {#if onDeleteItem}<IconButton tone="destructive" title={itemDeleteLabel} aria-label={itemDeleteLabel} onclick={() => { void deleteItem(index) }}><TrashIcon /></IconButton>{/if}
                                </IconButtonGroup>
                            {/if}
                        </div>
                    {:else}
                        {#if !showNoneOption}
                            <EmptyState
                                layout="overlay"
                                size={normalizedSearchQuery ? 'default' : folderEmptySize}
                                title={normalizedSearchQuery ? undefined : emptyMessage}
                                description={normalizedSearchQuery ? undefined : ''}
                            />
                        {/if}
                    {/each}
                    {@render listFooter?.()}
                    {#if showNoneOption}
                        <button
                            type="button"
                            class="risu-selectable-row w-full h-9 flex items-center rounded-md text-left px-2 text-sm text-subtext"
                            data-selected={noneSelected}
                            data-preset-select-none
                            onclick={onSelectNone}
                        >
                            <span class="truncate">{noneLabel}</span>
                        </button>
                    {/if}
                </SortableList>
            {/if}
            {@render children?.()}
        </section>
    </div>
</div>
</div>
</OverlayPortal>

<style>
    /* CSS draws text-overflow ellipses using the truncating element's own
       color. When an item combines a primary label with secondary details,
       keep the label primary but make the generated ellipsis secondary too. */
    .preset-picker-item :global(.truncate:has(> .text-subtext)) {
        color: var(--risu-theme-subtext);
    }

    .preset-picker-item :global(.truncate:has(> .text-subtext) > :not(.text-subtext):not(.isModuleGlobal)) {
        color: var(--risu-theme-maintext);
    }

    .folder-drop-target {
        background: color-mix(in srgb, var(--risu-theme-selected) 50%, transparent);
        box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--risu-theme-selected) 70%, transparent);
    }
</style>
