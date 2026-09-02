<script lang="ts">
    import { changeChar, emptyCharacterTrash, getCharImage, removeChar } from "../../ts/characters";
    import { type Database } from "../../ts/storage/database.svelte";
    import { DBState, selectedCharID } from 'src/ts/stores.svelte';
    import BarIcon from "../SideBars/BarIcon.svelte";
    import {
        ChevronDownIcon,
        LayoutGridIcon,
        ListIcon,
        MessageSquareIcon,
        SearchIcon,
        TrashIcon,
        Undo2Icon,
        CircleXIcon,
    } from "@lucide/svelte";
    import { language } from "src/lang";
    import { checkCharOrder, requestImmediateSave } from "src/ts/globalApi.svelte";
    import IconButton from "../UI/GUI/IconButton.svelte";
    import IconButtonGroup from "../UI/GUI/IconButtonGroup.svelte";
    import MultiLangDisplay from "../UI/GUI/MultiLangDisplay.svelte";
    import { makeAgoText } from "src/ts/util";
    import SettingTabs from "../UI/GUI/SettingTabs.svelte";
    import ShInput from "../UI/GUI/ShInput.svelte";
    import CharacterMasonryIcon from "../UI/CharacterMasonryIcon.svelte";
    import HorizontalMasonry from "../UI/HorizontalMasonry.svelte";
    import { readViewPreference, viewPreferenceKeys, writeViewPreference } from "src/ts/viewPreference";
    import { doingAlert } from "src/ts/alert";

    interface Props {
        endGrid?: () => void;
    }

    type CatalogCharacter = {
        chaId: string;
        image: string;
        index: number;
        name: string;
        desc: string;
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

    function setViewMode(mode: 'simple' | 'grid') {
        viewMode = mode;
        writeViewPreference(viewPreferenceKeys.characterCatalog, mode);
    }

    function selectAndClose(index = -1){
        changeChar(index);
        endGrid();
    }

    function handleEscape(event: KeyboardEvent) {
        if (event.key !== 'Escape' || event.isComposing) return;
        if (doingAlert() || document.querySelector('[aria-modal="true"][data-state="open"]')) return;

        event.preventDefault();
        event.stopPropagation();
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
                desc: character.creatorNotes ?? '',
                chats: character.chats.length,
                interaction: character.lastInteraction || 0,
            });
        }

        return characters;
    }

    function simpleChars(searchValue: string, db: Database) {
        return formatChars(searchValue, db).sort((a, b) => {
            if (a.interaction === b.interaction) return a.name.localeCompare(b.name);
            return b.interaction - a.interaction;
        });
    }

    async function deleteCharacter(
        event: MouseEvent & { currentTarget: EventTarget & HTMLButtonElement },
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
        if (emptyingTrash || deletingCharacterId !== null) return;

        emptyingTrash = true;
        try {
            await emptyCharacterTrash();
        } finally {
            emptyingTrash = false;
        }
    }
</script>

<svelte:window onkeydown={handleEscape} />

<div class="relative flex h-full w-full min-w-0 grow justify-center bg-bgcolor">
    <section class="relative flex h-full w-full max-w-5xl flex-col overflow-hidden bg-bgcolor">
        <button
            class="risu-layer-composer absolute right-2 top-2 flex items-center justify-center text-textcolor risu-interactive-accent"
            aria-label={language.close}
            title={language.close}
            onclick={endGrid}
        >
            <CircleXIcon size={DBState.db.settingsCloseButtonSize} />
        </button>
        <header class="shrink-0 border-b border-darkborderc px-4 py-4 pr-14 sm:px-6 sm:pr-14">
            <div class="mb-3 flex items-baseline gap-2">
                <h1 class="text-xl font-bold text-textcolor">{language.character}</h1>
                <span class="text-xs text-textcolor2">
                    {language.characterCount(formatChars(search, DBState.db, section === 1).length)}
                </span>
            </div>
            <div class="flex items-center gap-2">
                <SettingTabs
                    tabs={[
                        { label: language.normal, value: 0 },
                        { label: language.trash, value: 1 },
                    ]}
                    bind:selected={section}
                    className="mb-0 w-auto shrink-0 border-b-0"
                />
                <div class="relative min-w-0 grow">
                    <SearchIcon
                        size={16}
                        class="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-textcolor2"
                        aria-hidden="true"
                    />
                    <ShInput
                        className="h-9 min-h-9 pl-9"
                        placeholder={language.search}
                        bind:value={search}
                        autocomplete="off"
                    />
                </div>
                {#if section === 0}
                    <IconButtonGroup size="lg" className="shrink-0 rounded-md border border-darkborderc bg-bgcolor p-1">
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
                    <IconButtonGroup size="lg" className="shrink-0 rounded-md border border-draculared/40 bg-draculared/20 p-1 transition-colors hover:bg-draculared/30">
                        <IconButton
                            tone="destructive"
                            className="text-draculared"
                            title={language.emptyTrash}
                            aria-label={language.emptyTrash}
                            disabled={formatChars('', DBState.db, true).length === 0 || deletingCharacterId !== null || emptyingTrash}
                            onclick={handleEmptyTrash}
                        >
                            <TrashIcon />
                        </IconButton>
                    </IconButtonGroup>
                {/if}
            </div>
        </header>

        <div class="min-h-0 grow overflow-y-auto px-4 py-4 sm:px-6">
            {#if section === 1}
                <p class="mb-4 text-sm text-textcolor2">{language.trashDesc}</p>
                <div class="flex flex-col gap-2">
                    {#each formatChars(search, DBState.db, true) as char (char.chaId)}
                        <article class="flex items-center gap-3 rounded-md border border-darkborderc bg-bgcolor/20 p-3">
                            <BarIcon interactive={false} additionalStyle={getCharImage(char.image, 'css')}></BarIcon>
                            <h2 class="min-w-0 grow truncate font-semibold text-textcolor">{char.name}</h2>
                            <IconButtonGroup>
                                <IconButton title={language.restore} aria-label={language.restore} disabled={deletingCharacterId !== null || emptyingTrash} onclick={(event) => restoreCharacter(event, char)}>
                                    <Undo2Icon />
                                </IconButton>
                                <IconButton
                                    tone="destructive"
                                    title={language.deletePermanently}
                                    aria-label={language.deletePermanently}
                                    disabled={deletingCharacterId !== null || emptyingTrash}
                                    onclick={(event) => deleteCharacter(event, char, true)}
                                >
                                    <TrashIcon />
                                </IconButton>
                            </IconButtonGroup>
                        </article>
                    {:else}
                        <div class="flex min-h-48 items-center justify-center rounded-md border border-dashed border-darkborderc text-sm text-textcolor2">
                            {language.noData}
                        </div>
                    {/each}
                </div>
            {:else if viewMode === 'grid'}
                {@const gridCharacters = formatChars(search, DBState.db)}
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
                    <div class="flex min-h-48 items-center justify-center rounded-md border border-dashed border-darkborderc text-sm text-textcolor2">
                        {language.noData}
                    </div>
                {/if}
            {:else}
                <div class="flex flex-col gap-2">
                    {#each simpleChars(search, DBState.db) as char (char.chaId)}
                        <article class="rounded-md border border-darkborderc bg-bgcolor/20 transition-colors hover:bg-bgcolor/40">
                            <div class="flex items-stretch">
                                <button
                                    type="button"
                                    class="flex min-w-0 grow items-center gap-3 p-3 text-left"
                                    title={language.goToChat}
                                    onclick={() => selectAndClose(char.index)}
                                >
                                    <div class="shrink-0">
                                        <BarIcon interactive={false} additionalStyle={getCharImage(char.image, 'css')}></BarIcon>
                                    </div>
                                    <div class="min-w-0 grow">
                                        <h2 class="truncate font-semibold text-textcolor">{char.name}</h2>
                                        <span class="mt-1 flex items-center gap-1.5 text-xs text-textcolor2">
                                            <MessageSquareIcon size={12} />{char.chats}
                                            {#if char.interaction > 0}
                                                <span aria-hidden="true">·</span>{makeAgoText(char.interaction)}
                                            {/if}
                                        </span>
                                    </div>
                                </button>
                                <div class="flex shrink-0 items-center py-3 pl-2 pr-3">
                                    <IconButtonGroup>
                                        <IconButton
                                            tone="destructive"
                                            title={language.trash}
                                            aria-label={language.trash}
                                            disabled={deletingCharacterId !== null || emptyingTrash}
                                            onclick={(event) => deleteCharacter(event, char)}
                                        >
                                            <TrashIcon />
                                        </IconButton>
                                    </IconButtonGroup>
                                </div>
                            </div>
                            {#if char.desc.trim()}
                                <details class="group/notes border-t border-darkborderc">
                                    <summary class="flex h-8 cursor-pointer list-none items-center justify-between px-3 text-sm font-medium text-textcolor2 transition-colors risu-interactive-foreground">
                                        {language.creatorNotes}
                                        <ChevronDownIcon class="transition-transform group-open/notes:rotate-180" size={16} />
                                    </summary>
                                    <div class="bg-darkbg/30 px-3 py-2 text-xs text-textcolor2">
                                        <MultiLangDisplay value={char.desc} markdown={true} showLanguageSelector={false} contentClass="prose-sm" />
                                    </div>
                                </details>
                            {/if}
                        </article>
                    {:else}
                        <div class="flex min-h-48 items-center justify-center rounded-md border border-dashed border-darkborderc text-sm text-textcolor2">
                            {language.noData}
                        </div>
                    {/each}
                </div>
            {/if}
        </div>
    </section>
</div>
