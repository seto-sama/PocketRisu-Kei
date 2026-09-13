<script lang="ts">
    import { language } from "src/lang";
    import { openSettings, SettingsRoute } from "src/ts/routing";
    import { DBState, OtherBotsSubmenuIndex } from "src/ts/stores.svelte";
    import PresetBindingTrigger from "./PresetBindingTrigger.svelte";
    import PresetPickerLayout from "./PresetPickerLayout.svelte";

    // Legacy characters have no ttsPresetId. A bindable prop with a concrete
    // fallback cannot accept an explicitly bound undefined value in Svelte 5.
    let { value = $bindable() }: { value?: string } = $props();
    let open = $state(false);
    let visibleItemIndexes = $state<number[]>([]);
    const presets = $derived(DBState.db.ttsPresets ?? []);
    const selectedIndex = $derived(presets.findIndex(preset => preset.id === value));
    const selectedPreset = $derived(selectedIndex >= 0 ? presets[selectedIndex] : undefined);

    function select(index: number) {
        value = presets[index]?.id ?? '';
        open = false;
    }

    function configure() {
        open = false;
        OtherBotsSubmenuIndex.set(1);
        openSettings(SettingsRoute.OtherBots);
    }
</script>

<PresetBindingTrigger
    label={language.ttsPresetBinding}
    activeName={selectedPreset?.name ?? (value ? language.modelPresetDeleted : language.disabled)}
    onOpen={() => open = true}
    state={selectedPreset ? 'selected' : value ? 'warning' : 'empty'}
/>

{#if open}
    <PresetPickerLayout
        title={language.ttsPresetBinding}
        folders={[]}
        itemFolderIds={presets.map(() => undefined)}
        itemNames={presets.map(preset => preset.name)}
        itemDragDataKey="ttsBindingPresetIndex"
        showCreateFolder={false}
        showUncategorized={false}
        folderReadOnly
        allowItemReorder={false}
        bind:visibleItemIndexes
        bind:open
        configure={configure}
        onFoldersChange={() => {}}
        onAssignItem={() => {}}
        onDeleteFolder={() => {}}
        selectedItemIndex={selectedIndex}
        onSelectItem={select}
        onSelectNone={() => select(-1)}
        noneSelected={!value}
        noneLabel={language.disabled}
    >
        {#snippet itemContent(index)}
            <span class="truncate flex-1">{presets[index].name}</span>
        {/snippet}
    </PresetPickerLayout>
{/if}
