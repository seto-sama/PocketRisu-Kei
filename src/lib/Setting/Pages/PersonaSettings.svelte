<script lang="ts">
    import { ImageIcon, PlusIcon, TagsIcon } from "@lucide/svelte";
    import { onDestroy, tick } from "svelte";
    import { language } from "src/lang";
    import SettingRenderer from "src/lib/Setting/SettingRenderer.svelte";
    import SettingLayout from "src/lib/Setting/Wrappers/SettingLayout.svelte";
    import SettingPage from "../../UI/components/SettingPage.svelte";
    import Button from "../../UI/components/Button.svelte";
    import { getCharImage } from "src/ts/characters";
    import { changeUserPersona, createUserPersona, deleteUserPersona, exportUserPersona, reorderUserPersonas, saveUserPersona, selectUserImg } from "src/ts/persona";
    import type { SettingItem } from "src/ts/setting/types";
    import { DBState, openPersonaList } from "src/ts/stores.svelte";
    import AvatarFallback from "src/lib/UI/AvatarFallback.svelte";
    import SidebarAvatar from "src/lib/SideBars/SidebarAvatar.svelte";
    import HorizontalWheelScroller from "src/lib/UI/components/HorizontalWheelScroller.svelte";
    import SortableList from "src/lib/UI/components/SortableList.svelte";
    import type { RisuPersona } from "src/ts/storage/database.svelte";

    const PERSONA_PICKER_ITEM_SIZE = 56;
    const activePersona = $derived(DBState.db.personas[DBState.db.selectedPersona]);
    let personaScroller = $state<HTMLDivElement>();
    let lastScrolledPersona: RisuPersona | null = null;
    const basicInfoItems: SettingItem[] = [
        {
            id: 'persona.name',
            type: 'text',
            labelKey: 'name',
            helpKey: 'personaName',
            bindKey: 'username',
        },
        {
            id: 'persona.note',
            type: 'text',
            labelKey: 'note',
            helpKey: 'personaNote',
            bindKey: 'userNote',
            options: { placeholder: '[Alternate Hunters persona]' },
        },
        {
            id: 'persona.largePortrait',
            type: 'check',
            labelKey: 'largePortrait',
            helpKey: 'personaLargePortrait',
            getValue: (db) => !!db.personas[db.selectedPersona]?.largePortrait,
            setValue: (db, value: boolean) => { db.personas[db.selectedPersona].largePortrait = value; },
        },
    ];
    const descriptionItems: SettingItem[] = [{
        id: 'persona.description',
        type: 'textarea',
        labelKey: 'description',
        helpKey: 'personaDescription',
        bindKey: 'personaPrompt',
        options: {
            placeholder: 'Put the description of this persona here.\nExample: [<user> is a 20 year old girl.]',
            showTokenCount: true,
        },
    }];

    function openPersonaManager() {
        saveUserPersona();
        openPersonaList.set(true);
    }

    function selectPersona(index: number) {
        if (index === DBState.db.selectedPersona) return;
        changeUserPersona(index);
    }

    function scrollPersonaIntoView(index: number) {
        if (!personaScroller) return;
        const personaItem = personaScroller.querySelector<HTMLElement>(`[data-persona-index="${index}"]`);
        if (!personaItem) return;

        const scrollerRect = personaScroller.getBoundingClientRect();
        const itemRect = personaItem.getBoundingClientRect();
        let left = personaScroller.scrollLeft;
        if (itemRect.left < scrollerRect.left) left += itemRect.left - scrollerRect.left;
        else if (itemRect.right > scrollerRect.right) left += itemRect.right - scrollerRect.right;
        else return;

        personaScroller.scrollTo({ left, behavior: 'smooth' });
    }

    $effect(() => {
        const selectedPersona = DBState.db.selectedPersona;
        const selectedPersonaData = DBState.db.personas[selectedPersona];
        if (selectedPersonaData === lastScrolledPersona) return;
        lastScrolledPersona = selectedPersonaData;
        void tick().then(() => scrollPersonaIntoView(selectedPersona));
    });

    onDestroy(() => {
        saveUserPersona();
    });
</script>

<SettingPage title={language.persona}>
    <div class="mb-4 flex h-[5.5rem] w-full gap-2">
        <div class="flex h-full w-0 min-w-0 grow overflow-hidden rounded-md border border-darkborderc bg-darkbg">
            <HorizontalWheelScroller
                bind:element={personaScroller}
                className="h-full w-full min-w-0 overflow-x-auto overflow-y-hidden overscroll-x-contain"
                role="group"
                aria-label={language.currentPersona}
            >
                <SortableList
                    className="box-border flex h-full min-w-full w-max items-center gap-4 px-4 py-4"
                    draggable="[data-persona-index]"
                    dataAttribute="data-persona-index"
                    options={{
                        direction: 'horizontal',
                        forceFallback: true,
                        fallbackOnBody: true,
                        fallbackTolerance: 3,
                        fallbackClass: 'persona-sortable-fallback',
                    }}
                    onReorder={(orderedIndexes) => reorderUserPersonas(orderedIndexes.map(Number))}
                >
                    {#each DBState.db.personas as persona, index (persona)}
                        <button
                            type="button"
                            data-persona-index={index}
                            class="persona-picker-item flex shrink-0 items-center justify-center"
                            style={`--persona-picker-item-size: ${PERSONA_PICKER_ITEM_SIZE}px`}
                            aria-current={index === DBState.db.selectedPersona ? 'true' : undefined}
                            aria-label={`${language.select}: ${persona.name || '—'}`}
                            onclick={() => selectPersona(index)}
                        >
                            <SidebarAvatar
                                rounded={false}
                                src={persona.icon ? getCharImage(persona.icon, 'plain') : ''}
                                name={persona.name || '—'}
                                size={String(PERSONA_PICKER_ITEM_SIZE)}
                                selected={index === DBState.db.selectedPersona}
                                interactive={false}
                                showTooltip={false}
                            />
                        </button>
                    {/each}
                </SortableList>
            </HorizontalWheelScroller>
        </div>

        <div class="flex w-10 shrink-0 flex-col gap-2">
            <Button variant="outline" size="icon" onclick={createUserPersona} aria-label={language.newPersona} title={language.newPersona}>
                <PlusIcon />
            </Button>
            <Button variant="outline" size="icon" onclick={openPersonaManager} aria-label={language.personaTagManagement} title={language.personaTagManagement}>
                <TagsIcon />
            </Button>
        </div>
    </div>

    <SettingLayout variant="section" title={language.basicInfo} first>
        <div class="flex items-start gap-5 py-4 max-sm:flex-col">
            <div class="flex h-[16.5rem] w-44 shrink-0 flex-col gap-2 max-sm:h-auto max-sm:w-full max-sm:items-center">
                <button
                    type="button"
                    class="relative w-44 overflow-hidden rounded-md border border-darkborderc bg-button shadow-lg transition-[height,aspect-ratio,border-color] duration-200 hover:border-lightborderc max-sm:h-auto max-sm:w-full {activePersona?.largePortrait ? 'h-56 max-sm:aspect-[11/14]' : 'h-44 max-sm:aspect-square'}"
                    aria-label={language.select}
                    onclick={selectUserImg}
                >
                    {#if DBState.db.userIcon}
                        {#await getCharImage(DBState.db.userIcon, 'css')}
                            <div class="h-full w-full animate-pulse bg-button"></div>
                        {:then imageStyle}
                            <div class="h-full w-full bg-cover bg-center" style={imageStyle}></div>
                        {/await}
                    {:else}
                        <AvatarFallback className="h-full w-full" iconSize={56} />
                    {/if}
                </button>
                <Button variant="outline" size="sm" className="w-full" onclick={selectUserImg}>
                    <ImageIcon/>
                    {language.select}
                </Button>
            </div>

            <div class="min-w-0 grow">
                <SettingRenderer items={basicInfoItems} layout="row" />
            </div>
        </div>
    </SettingLayout>

    <div>
        <SettingRenderer items={descriptionItems} layout="row" />
    </div>

    <SettingLayout variant="section" title={language.personaManagement}>
        <div class="[&>*:first-child]:border-t-0">
            <SettingLayout
                variant="row"
                title={language.presetExport}
                description={language.help.personaExport}
                actionLabel={language.presetExport}
                onAction={() => exportUserPersona(DBState.db.selectedPersona)}
            />
            <SettingLayout
                variant="row"
                title={language.remove}
                description={language.help.personaDelete}
                actionLabel={language.remove}
                actionVariant="destructive"
                actionDisabled={DBState.db.personas.length <= 1}
                onAction={() => deleteUserPersona(DBState.db.selectedPersona)}
            />
        </div>
    </SettingLayout>
</SettingPage>

<style>
    :global(.persona-picker-item) {
        width: var(--persona-picker-item-size);
        min-width: var(--persona-picker-item-size);
        max-width: var(--persona-picker-item-size);
        height: var(--persona-picker-item-size);
        min-height: var(--persona-picker-item-size);
        max-height: var(--persona-picker-item-size);
        flex: 0 0 var(--persona-picker-item-size);
    }

    :global(.persona-picker-item:is(.risu-ghost-item, .risu-drag-item, .persona-sortable-fallback)) {
        width: var(--persona-picker-item-size) !important;
        min-width: var(--persona-picker-item-size) !important;
        max-width: var(--persona-picker-item-size) !important;
        height: var(--persona-picker-item-size) !important;
        min-height: var(--persona-picker-item-size) !important;
        max-height: var(--persona-picker-item-size) !important;
        overflow: hidden !important;
    }

    :global(.persona-picker-item:is(.risu-ghost-item, .risu-drag-item, .persona-sortable-fallback) :is(.avatar, .avatar-tile, img)) {
        width: var(--persona-picker-item-size) !important;
        min-width: var(--persona-picker-item-size) !important;
        max-width: var(--persona-picker-item-size) !important;
        height: var(--persona-picker-item-size) !important;
        min-height: var(--persona-picker-item-size) !important;
        max-height: var(--persona-picker-item-size) !important;
        object-fit: cover;
    }
</style>
