<script lang="ts">
    import { onDestroy } from "svelte";
    import * as ContextMenu from "../UI/components/context-menu";
    import SettingNumber from "../Setting/Wrappers/SettingNumber.svelte";
    import type { SettingItem } from "src/ts/setting/types";
    import { normalizeTrashRetentionDays } from "src/ts/trashRetention";
    import SortableList from "../UI/components/SortableList.svelte";
    import { readSidebarOrderFromDom } from "../SideBars/sidebarDrag";
    import type { MoveEvent } from "sortablejs";
    import SidebarAvatar from "../SideBars/SidebarAvatar.svelte";
    import { getFolderColorStyle } from "../SideBars/folderColors";
    import { folderDisplayMode } from "../SideBars/folderDisplay";
    import { folderIconComponent } from "../SideBars/folderIcons";
    import { openSidebarFolderMenu } from "../SideBars/sidebarFolderMenu";
    import type { folder } from "src/ts/storage/database.svelte";
    import EmptyState from "src/lib/UI/components/EmptyState.svelte";
    import { changeChar, emptyCharacterTrash, getCharImage, removeChar } from "../../ts/characters";
    import { type Database } from "../../ts/storage/database.svelte";
    import { DBState, selectedCharID } from 'src/ts/stores.svelte';
    import {
        EyeIcon,
        EyeOffIcon,
        FolderIcon,
        FolderOpenIcon,
        EllipsisVerticalIcon,
        LayoutGridIcon,
        ListIcon,
        MessageSquareIcon,
        SearchIcon,
        TrashIcon,
        Undo2Icon,
        XIcon,
    } from "@lucide/svelte";
    import { language } from "src/lang";
    import { checkCharOrder, requestImmediateSave } from "src/ts/globalApi.svelte";
    import IconButton from "../UI/components/IconButton.svelte";
    import IconButtonGroup from "../UI/components/IconButtonGroup.svelte";
    import { makeAgoText } from "src/ts/util";
    import SettingTabs from "../UI/components/SettingTabs.svelte";
    import Input from "../UI/components/Input.svelte";
    import CharacterMasonryIcon from "../UI/CharacterMasonryIcon.svelte";
    import HorizontalMasonry from "../UI/HorizontalMasonry.svelte";
    import { readViewPreference, viewPreferenceKeys, writeViewPreference } from "src/ts/viewPreference";

    interface Props {
        endGrid?: () => void;
    }

    type CatalogCharacter = {
        chaId: string;
        image: string;
        index: number;
        name: string;
        chats: number;
        interaction: number;
    };

    let { endGrid = () => {} }: Props = $props();
    let search = $state('');
    let section = $state(0);
    let viewMode = $state<'simple' | 'grid'>(
        readViewPreference(viewPreferenceKeys.characterCatalog, ['simple', 'grid'], 'simple'),
    );
    let deletingCharacterId = $state<string | null>(null);
    let emptyingTrash = $state(false);

    const trashRetentionSetting: SettingItem = $derived({
        id: 'trashRetentionDays',
        type: 'number',
        labelKey: 'trashAutoDeleteSchedule',
        helpKey: 'trashAutoDeleteSchedule',
        getValue: (db) => normalizeTrashRetentionDays(db.trashRetentionDays),
        setValue: (db, value) => { db.trashRetentionDays = normalizeTrashRetentionDays(value); },
        options: { min: 0, suffix: language.trashRetentionDaysSuffix },
    });

    function setViewMode(mode: 'simple' | 'grid') {
        viewMode = mode;
        writeViewPreference(viewPreferenceKeys.characterCatalog, mode);
    }

    function selectAndClose(index = -1){
        if (suppressRowClick) return;
        changeChar(index);
        endGrid();
    }

    function formatChars(searchValue: string, db: Database, trash = false): CatalogCharacter[] {
        const normalizedSearch = searchValue.replace(/ /g, "").toLocaleLowerCase();
        const characters: CatalogCharacter[] = [];

        for(let i = 0; i < db.characters.length; i++){
            const character = db.characters[i];
            if(character.trashTime && !trash) continue;
            if(!character.trashTime && trash) continue;
            if(!character.name.replace(/ /g, "").toLocaleLowerCase().includes(normalizedSearch)) continue;

            characters.push({
                chaId: character.chaId,
                image: character.image,
                index: i,
                name: character.name || "Unnamed",
                chats: character.chats.length,
                interaction: character.lastInteraction || 0,
            });
        }

        return characters;
    }

    const visibleCharacters = $derived(formatChars(search, DBState.db, section === 1));

    const hiddenCharacterIds = $derived(new Set(DBState.db.nodeOnlyHiddenCharacterIds ?? []));

    function toggleCharacterHidden(id: string) {
        const next = new Set(hiddenCharacterIds);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        DBState.db.nodeOnlyHiddenCharacterIds = [...next];
    }

    let orderElement: HTMLDivElement | undefined = $state();
    let suppressRowClick = false;
    let releaseClickFrame = 0;
    onDestroy(() => cancelAnimationFrame(releaseClickFrame));
    const orderSortableOptions = {
        group: 'character-catalog',
        onMove: (event: MoveEvent) => !(event.dragged.dataset.sidebarKind === 'folder' && event.to.dataset.sortableContainerKey),
    };

    function syncCharacterOrder() {
        if (!orderElement) return;
        DBState.db.characterOrder = readSidebarOrderFromDom(orderElement, DBState.db.characterOrder);
        checkCharOrder();
    }

    function finishOrderDrag() {
        suppressRowClick = true;
        cancelAnimationFrame(releaseClickFrame);
        releaseClickFrame = requestAnimationFrame(() => { suppressRowClick = false; });
    }

    let collapsedFolders = $state<Set<string>>(new Set());
    const listEntries = $derived.by(() => {
        const byId = new Map(visibleCharacters.map(character => [character.chaId, character]));
        const entries: ({ type: 'character'; character: CatalogCharacter } | { type: 'folder'; folder: folder; characters: CatalogCharacter[] })[] = [];
        const take = (id: string) => {
            const character = byId.get(id);
            byId.delete(id);
            return character;
        };
        for (const entry of DBState.db.characterOrder) {
            if (typeof entry === 'string') {
                const character = take(entry);
                if (character) entries.push({ type: 'character', character });
            } else {
                const children = entry.data.map(take).filter((character): character is CatalogCharacter => !!character);
                if (children.length || !search.trim()) entries.push({ type: 'folder', folder: entry, characters: children });
            }
        }
        // Keep characters visible while their sidebar order is being normalized.
        for (const character of byId.values()) entries.push({ type: 'character', character });
        return entries;
    });

    function toggleFolder(id: string) {
        if (suppressRowClick) return;
        const next = new Set(collapsedFolders);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        collapsedFolders = next;
    }

    async function deleteCharacter(
        event: MouseEvent & { currentTarget: EventTarget & HTMLElement },
        character: CatalogCharacter,
        permanent = false,
    ) {
        // Do not restore focus to a row that may represent a different character
        // after deletion. Held Enter keys would otherwise activate that next row.
        event.currentTarget.blur();
        if (deletingCharacterId !== null || emptyingTrash) return;

        deletingCharacterId = character.chaId;
        try {
            await removeChar(character.index, character.name, permanent ? 'permanent' : 'normal');
        } finally {
            deletingCharacterId = null;
        }
    }

    async function restoreCharacter(
        event: MouseEvent & { currentTarget: EventTarget & HTMLButtonElement },
        character: CatalogCharacter,
    ) {
        event.currentTarget.blur();
        if (deletingCharacterId !== null || emptyingTrash) return;

        deletingCharacterId = character.chaId;
        const current = DBState.db.characters.find((item) => item.chaId === character.chaId);
        if (!current) {
            deletingCharacterId = null;
            return;
        }

        try {
            current.trashTime = undefined;
            checkCharOrder();
            await requestImmediateSave({ characterIds: [character.chaId] });
        } finally {
            deletingCharacterId = null;
        }
    }

    async function handleEmptyTrash(event: MouseEvent) {
        (event.currentTarget as HTMLElement | null)?.blur();
        if (emptyingTrash || deletingCharacterId !== null || !DBState.db.characters.some(character => character.trashTime)) return;

        emptyingTrash = true;
        try {
            await emptyCharacterTrash();
        } finally {
            emptyingTrash = false;
        }
    }
</script>

<div class="relative flex h-full w-full min-w-0 grow justify-center bg-lightbg">
    <section class="relative flex h-full w-full max-w-4xl flex-col overflow-hidden bg-lightbg">
        <button
            data-risu-dialog-close
            class="risu-layer-composer absolute right-4 top-4 flex cursor-pointer items-center justify-center rounded-sm border border-transparent text-subtext transition-colors risu-interactive-foreground"
            aria-label={language.close}
            title={language.close}
            onclick={endGrid}
        >
            <XIcon size={18} />
        </button>
        <header class="shrink-0 px-4 pt-6 pb-2 sm:px-6">
            <div class="mb-4 flex items-baseline gap-2 pr-10">
                <h1 class="text-xl font-bold text-maintext">{language.characterList}</h1>
                <span class="text-xs text-subtext">
                    {language.characterCount(visibleCharacters.length)}
                </span>
            </div>
            <div class="flex items-center gap-2">
                <SettingTabs
                    tabs={[
                        { label: language.normal, value: 0 },
                        { label: language.trash, value: 1 },
                    ]}
                    bind:selected={section}
                    className="mb-0 w-auto shrink-0"
                />
                <div class="relative min-w-0 grow">
                    <SearchIcon
                        size={16}
                        class="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-subtext"
                        aria-hidden="true"
                    />
                    <Input
                        className="h-9 min-h-9 pl-9"
                        placeholder={language.search}
                        bind:value={search}
                        autocomplete="off"
                    />
                </div>
                {#if section === 0}
                    <IconButtonGroup size="lg" className="shrink-0 rounded-md border border-darkborderc bg-lightbg p-1">
                        <IconButton
                            active={viewMode === 'simple'}
                            activeColor="primary"
                            title={language.simple}
                            aria-label={language.simple}
                            onclick={() => setViewMode('simple')}
                        >
                            <ListIcon />
                        </IconButton>
                        <IconButton
                            active={viewMode === 'grid'}
                            activeColor="primary"
                            title={language.grid}
                            aria-label={language.grid}
                            onclick={() => setViewMode('grid')}
                        >
                            <LayoutGridIcon />
                        </IconButton>
                    </IconButtonGroup>
                {:else}
                    <ContextMenu.Root>
                        <ContextMenu.Trigger class="inline-flex shrink-0">
                            <IconButtonGroup size="lg" className="shrink-0 rounded-md border border-danger/40 bg-danger/20 p-1 transition-colors hover:bg-danger/30">
                                <IconButton
                                    tone="destructive"
                                    className="text-danger"
                                    title={language.emptyTrash}
                                    aria-label={language.emptyTrash}
                                    disabled={deletingCharacterId !== null || emptyingTrash}
                                    onclick={handleEmptyTrash}
                                >
                                    <TrashIcon />
                                </IconButton>
                            </IconButtonGroup>
                        </ContextMenu.Trigger>
                        <ContextMenu.Content class="w-96 max-w-[calc(100vw-2rem)] p-3 [&_[data-setting-id]]:border-0 [&_[data-setting-id]]:py-0">
                            <SettingNumber item={trashRetentionSetting} ctx={{ db: DBState.db, layout: 'row' }} />
                        </ContextMenu.Content>
                    </ContextMenu.Root>
                {/if}
            </div>
        </header>

        <div class="min-h-0 grow overflow-y-auto px-4 pt-2 pb-4 sm:px-6">
            {#if section === 1}
                <p class="mb-4 text-sm text-subtext">{language.trashDesc}</p>
                <div class="flex flex-col gap-2">
                    {#each visibleCharacters as char (char.chaId)}
                        {@render characterRow(char, true)}
                    {:else}
                        <div class="flex min-h-48 items-center justify-center rounded-md border border-dashed border-darkborderc text-sm text-subtext">
                            {#if search.trim()}
                                <EmptyState />
                            {:else}
                                <EmptyState title={language.noData} description="" />
                            {/if}
                        </div>
                    {/each}
                </div>
            {:else if viewMode === 'grid'}
                {@const gridCharacters = visibleCharacters}
                {#if gridCharacters.length > 0}
                    <HorizontalMasonry itemCount={gridCharacters.length}>
                        {#snippet children(index)}
                            {@const char = gridCharacters[index]}
                            <CharacterMasonryIcon
                                src={char.image ? getCharImage(char.image, 'plain') : ''}
                                name={char.name}
                                selected={char.index === $selectedCharID}
                                onclick={() => selectAndClose(char.index)}
                            />
                        {/snippet}
                    </HorizontalMasonry>
                {:else}
                    <div class="flex min-h-48 items-center justify-center rounded-md border border-dashed border-darkborderc text-sm text-subtext">
                        {#if search.trim()}
                            <EmptyState />
                        {:else}
                            <EmptyState title={language.noData} description="" />
                        {/if}
                    </div>
                {/if}
            {:else}
                <SortableList bind:element={orderElement} className="flex flex-col gap-2" disabled={!!search.trim()}
                    draggable="[data-sidebar-order-key]" dataAttribute="data-sidebar-order-key" handle=".character-order-handle"
                    options={orderSortableOptions} onReorder={syncCharacterOrder} onDragEnd={finishOrderDrag}>
                    {#each listEntries as entry (entry.type === 'folder' ? `folder:${entry.folder.id}` : entry.character.chaId)}
                        {#if entry.type === 'folder'}
                            {@const expanded = !!search.trim() || !collapsedFolders.has(entry.folder.id)}
                            {@const CustomIcon = folderDisplayMode(entry.folder, DBState.db.showFolderName) === 'icon' ? folderIconComponent(entry.folder.nodeOnlyIcon) : undefined}
                            {@const FolderGlyph = CustomIcon ?? (expanded ? FolderOpenIcon : FolderIcon)}
                            <div data-sidebar-order-key={entry.folder.id} data-sidebar-kind="folder" data-sortable-no-scale class="risu-folder-section flex flex-col" style:--risu-folder-color={getFolderColorStyle(entry.folder.color).accent}>
                                <div class="risu-folder-header risu-selectable-row text-maintext">
                                    <button class="character-order-handle flex min-w-0 grow items-center py-1 text-left" aria-expanded={expanded} onclick={() => toggleFolder(entry.folder.id)}>
                                        <FolderGlyph size={18} class="risu-folder-icon mr-2 shrink-0" />
                                        <span class="grow truncate text-sm font-medium">{entry.folder.name}</span>
                                        <span class="ml-2 text-xs text-subtext">{entry.characters.length}</span>
                                    </button>
                                    <IconButton className="ml-3 shrink-0" title={language.menu} aria-label={language.menu} onclick={() => openSidebarFolderMenu(entry.folder.id)}>
                                        <EllipsisVerticalIcon />
                                    </IconButton>
                                </div>
                                {#if expanded}
                                    <SortableList containerKey={entry.folder.id} className="risu-folder-children risu-tree-list risu-tree-list-centered flex min-h-8 flex-col [--risu-tree-gap:0.5rem] [--risu-tree-item-border:1px] gap-[var(--risu-tree-gap)] mt-2" disabled={!!search.trim()}
                                        draggable="[data-sidebar-order-key]" dataAttribute="data-sidebar-order-key" handle=".character-order-handle"
                                        options={orderSortableOptions} onReorder={syncCharacterOrder} onDragEnd={finishOrderDrag}>
                                        {#each entry.characters as char (char.chaId)}
                                            {@render characterRow(char)}
                                        {:else}
                                            <div class="py-2 text-xs text-subtext">{language.noData}</div>
                                        {/each}
                                    </SortableList>
                                {/if}
                            </div>
                        {:else}
                            {@render characterRow(entry.character)}
                        {/if}
                    {:else}
                        <div class="flex min-h-48 items-center justify-center rounded-md border border-dashed border-darkborderc text-sm text-subtext">
                            {#if search.trim()}
                                <EmptyState />
                            {:else}
                                <EmptyState title={language.noData} description="" />
                            {/if}
                        </div>
                    {/each}
                </SortableList>
            {/if}
        </div>
    </section>
</div>

{#snippet characterRow(char: CatalogCharacter, trash = false)}
    <article data-tree-item data-sidebar-order-key={char.chaId} data-sidebar-kind="character" data-sortable-no-scale class="rounded-md border border-darkborderc text-maintext {!trash && char.index === $selectedCharID ? 'bg-selected' : 'bg-darkbg risu-interactive-surface'}">
        <div class="flex min-h-12 items-center gap-2.5 p-2">
            {#if trash}
                <div class="flex min-w-0 grow items-center gap-2.5">
                    {@render characterInfo(char)}
                </div>
            {:else}
                <button class="character-order-handle flex min-w-0 grow items-center gap-2.5 text-left" title={language.goToChat} onclick={() => selectAndClose(char.index)}>
                    {@render characterInfo(char)}
                </button>
            {/if}
            <IconButtonGroup>
                {#if trash}
                    <IconButton title={language.restore} aria-label={language.restore} disabled={deletingCharacterId !== null || emptyingTrash} onclick={(event) => restoreCharacter(event, char)}>
                        <Undo2Icon />
                    </IconButton>
                {:else}
                    <IconButton
                        title={hiddenCharacterIds.has(char.chaId) ? language.showInSidebar : language.hideFromSidebar}
                        aria-label={hiddenCharacterIds.has(char.chaId) ? language.showInSidebar : language.hideFromSidebar}
                        aria-pressed={hiddenCharacterIds.has(char.chaId)}
                        onclick={() => toggleCharacterHidden(char.chaId)}
                    >
                        {#if hiddenCharacterIds.has(char.chaId)}<EyeOffIcon />{:else}<EyeIcon />{/if}
                    </IconButton>
                {/if}
                <IconButton tone="destructive" title={trash ? language.deletePermanently : language.trash} aria-label={trash ? language.deletePermanently : language.trash} disabled={deletingCharacterId !== null || emptyingTrash} onclick={(event) => deleteCharacter(event, char, trash)}>
                    <TrashIcon />
                </IconButton>
            </IconButtonGroup>
        </div>
    </article>
{/snippet}

{#snippet characterInfo(char: CatalogCharacter)}
    <SidebarAvatar src={char.image ? getCharImage(char.image, 'plain') : ''} name={char.name} size="40" rounded={DBState.db.roundIcons} interactive={false} showTooltip={false} />
    <span class="flex min-w-0 grow flex-col">
        <span class="truncate text-sm font-medium">{char.name}</span>
        <span class="flex items-center gap-1 text-xs text-subtext">
            {char.chats}<MessageSquareIcon size={12} />
            {#if char.interaction > 0}<span class="mx-1">|</span>{makeAgoText(char.interaction)}{/if}
        </span>
    </span>
{/snippet}
