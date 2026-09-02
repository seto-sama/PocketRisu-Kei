<script lang="ts">
    import { language } from 'src/lang'
    import { DBState } from 'src/ts/stores.svelte'
    import { openSettings, SettingsRoute } from 'src/ts/routing'
    import PresetPickerLayout from './PresetPickerLayout.svelte'
    import PresetBindingTrigger from './PresetBindingTrigger.svelte'

    interface Props {
        value?: string
        onChange?: (value: string) => void
        showConfigure?: boolean
        compact?: boolean
        open?: boolean
    }

    let {
        value = $bindable(''),
        onChange = () => {},
        showConfigure = false,
        compact = false,
        open = $bindable(false),
    }: Props = $props()

    let selectedFolder = $state('all')
    let visibleItemIndexes = $state<number[]>([])
    const presets = $derived(DBState.db.translatorPresets ?? [])
    const tags = $derived(DBState.db.translatorPresetTags ?? [])
    const selectedItemIndex = $derived(presets.findIndex(preset => preset.id === value))
    const selectedPreset = $derived(selectedItemIndex >= 0 ? presets[selectedItemIndex] : undefined)

    function selectPreset(index: number) {
        value = presets[index].id
        open = false
        onChange(value)
    }

    function configure() {
        open = false
        openSettings(SettingsRoute.Language)
    }
</script>

{#if open}
    <PresetPickerLayout
        title={`${language.translate} ${language.presets}`}
        folders={tags}
        itemFolderIds={presets.map(preset => preset.tagIds)}
        organizationKind="tag"
        itemNames={presets.map(preset => preset.name)}
        itemDragDataKey="translatorPresetIndex"
        bind:selectedFolder
        bind:visibleItemIndexes
        close={() => { open = false }}
        configure={showConfigure ? configure : undefined}
        readOnly
        onFoldersChange={() => {}}
        onAssignItem={() => {}}
        onDeleteFolder={() => {}}
        {selectedItemIndex}
        onSelectItem={selectPreset}
    >
        {#snippet itemContent(index)}
            <span class="truncate flex-1">{presets[index].name}</span>
        {/snippet}
    </PresetPickerLayout>
{/if}

{#if compact}
    <PresetBindingTrigger
        compact
        label={language.translationPrompt}
        activeName={selectedPreset?.name ?? language.modelPresetDeleted}
        onOpen={() => { open = true }}
        state={selectedPreset ? 'selected' : 'warning'}
    />
{:else}
    <PresetBindingTrigger
        label={language.translationPrompt}
        activeName={selectedPreset?.name ?? language.modelPresetDeleted}
        onOpen={() => { open = true }}
        state={selectedPreset ? 'selected' : 'warning'}
    />
{/if}
