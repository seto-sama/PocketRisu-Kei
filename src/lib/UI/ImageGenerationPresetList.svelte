<script lang="ts">
    import { SquarePenIcon } from '@lucide/svelte'
    import { language } from 'src/lang'
    import { alertConfirm, notifyError } from 'src/ts/alert'
    import {
        captureNAIImageCoreSettings,
        moveImageGenerationPreset,
        removeImageGenerationPreset,
        type NAIImageCoreSettings,
    } from 'src/ts/imageGeneration/presets'
    import { openSettings, SettingsRoute } from 'src/ts/routing'
    import { DBState, OtherBotsSubmenuIndex } from 'src/ts/stores.svelte'
    import IconButton from './GUI/IconButton.svelte'
    import ShButton from './GUI/ShButton.svelte'
    import ShDialog from './GUI/ShDialog.svelte'
    import TextInput from './GUI/TextInput.svelte'
    import NovelAIImageCoreSettings from './NovelAIImageCoreSettings.svelte'
    import PresetBindingTrigger from './PresetBindingTrigger.svelte'
    import PresetPickerLayout from './PresetPickerLayout.svelte'
    import { removePresetTag, togglePresetTag } from 'src/ts/preset/tags'

    interface Props {
        compact?: boolean
        open?: boolean
        showConfigure?: boolean
    }

    let {
        compact = false,
        open = $bindable(false),
        showConfigure = false,
    }: Props = $props()

    let selectedFolder = $state('all')
    let visibleItemIndexes = $state<number[]>([])
    let editorOpen = $state(false)
    let editingPresetId = $state('')
    let editorName = $state('')
    let editorSettings = $state<NAIImageCoreSettings>()
    const presets = $derived(DBState.db.imageGenerationPresets ?? [])
    const tags = $derived(DBState.db.imageGenerationPresetTags ?? [])
    const selectedItemIndex = $derived(DBState.db.imageGenerationPresetId)
    const selectedPreset = $derived(presets[selectedItemIndex])

    function selectPreset(index: number) {
        const preset = presets[index]
        if (!preset) return
        DBState.db.imageGenerationPresetId = index
        open = false
    }

    function configure() {
        open = false
        OtherBotsSubmenuIndex.set(2)
        openSettings(SettingsRoute.OtherBots)
    }

    function startEdit(index: number) {
        const preset = presets[index]
        if (!preset) return
        editingPresetId = preset.id
        editorName = preset.name
        editorSettings = captureNAIImageCoreSettings(preset.settings)
        editorOpen = true
    }

    function saveEditor() {
        const draft = editorSettings
        const name = editorName.trim()
        const index = presets.findIndex(preset => preset.id === editingPresetId)
        const preset = presets[index]
        if (!draft || !preset || !name) return
        const sourceConfig = draft.NAIImgConfig
        const nextPresets = [...presets]
        nextPresets[index] = {
            ...preset,
            name,
            settings: {
                ...preset.settings,
                NAIImgSizePreset: draft.NAIImgSizePreset,
                NAIImgOrientation: draft.NAIImgOrientation,
                NAIImgConfig: {
                    ...preset.settings.NAIImgConfig,
                    width: sourceConfig.width,
                    height: sourceConfig.height,
                    sampler: sourceConfig.sampler,
                    noise_schedule: sourceConfig.noise_schedule,
                    steps: sourceConfig.steps,
                    scale: sourceConfig.scale,
                    cfg_rescale: sourceConfig.cfg_rescale,
                },
            },
        }
        DBState.db.imageGenerationPresets = nextPresets
        editorOpen = false
    }

    $effect(() => {
        if (editorOpen) return
        editorSettings = undefined
        editingPresetId = ''
        editorName = ''
    })

    async function deletePreset(index: number) {
        if (presets.length <= 1) {
            notifyError(language.errors.onlyOnePreset)
            return
        }
        const preset = presets[index]
        if (!preset || !await alertConfirm(`${language.removeConfirm}${preset.name}`)) return
        if (removeImageGenerationPreset(DBState.db, index) && editingPresetId === preset.id) {
            editorOpen = false
        }
    }
</script>

{#if open}
    <PresetPickerLayout
        title={language.imageGenerationPreset}
        folders={tags}
        itemFolderIds={presets.map(preset => preset.tagIds)}
        organizationKind="tag"
        itemNames={presets.map(preset => preset.name)}
        itemDragDataKey="imageGenerationPresetIndex"
        bind:selectedFolder
        bind:visibleItemIndexes
        close={() => { open = false }}
        configure={showConfigure ? configure : undefined}
        onFoldersChange={(nextTags) => { DBState.db.imageGenerationPresetTags = nextTags }}
        onAssignItem={(index, tagId) => {
            const preset = presets[index]
            if (!preset) return
            DBState.db.imageGenerationPresets = presets.map((item, presetIndex) => presetIndex === index
                ? { ...item, tagIds: togglePresetTag(item.tagIds, tagId) }
                : item)
        }}
        onDeleteFolder={(tagId) => {
            DBState.db.imageGenerationPresets = presets.map(preset => ({
                ...preset,
                tagIds: removePresetTag(preset.tagIds, tagId),
            }))
        }}
        onMoveItem={(fromIndex, toIndex) => { moveImageGenerationPreset(DBState.db, fromIndex, toIndex) }}
        onDeleteItem={deletePreset}
        {selectedItemIndex}
        onSelectItem={selectPreset}
    >
        {#snippet itemContent(index)}
            <span class="truncate flex-1">{presets[index].name}</span>
        {/snippet}
        {#snippet itemActions(index)}
            <IconButton onclick={() => startEdit(index)} aria-label={language.edit} title={language.edit}>
                <SquarePenIcon />
            </IconButton>
        {/snippet}
    </PresetPickerLayout>
{/if}

<PresetBindingTrigger
    {compact}
    label={language.imageGenerationPreset}
    activeName={selectedPreset?.name ?? language.modelPresetDeleted}
    onOpen={() => { open = true }}
    state={selectedPreset ? 'selected' : 'warning'}
/>

<ShDialog bind:open={editorOpen} size="default" closeOnEscape closeOnOutsideClick closable>
    {#snippet title()}{language.imageGenerationPreset} {language.edit}{/snippet}
    {#if editorSettings}
        <label class="flex items-center justify-between gap-3 pb-3 text-sm text-maintext">
            <span>{language.imageGenerationPresetName}</span>
            <TextInput bind:value={editorName} commitMode="input" className="w-48 text-sm" size="sm" />
        </label>
        <div class="[&>*:first-child]:border-t-0 border-t border-darkborderc">
            <NovelAIImageCoreSettings settings={editorSettings} />
        </div>
    {/if}
    {#snippet footer()}
        <ShButton variant="outline" onclick={() => { editorOpen = false }}>{language.cancel}</ShButton>
        <ShButton variant="primary" disabled={!editorName.trim()} onclick={saveEditor}>{language.confirm}</ShButton>
    {/snippet}
</ShDialog>
