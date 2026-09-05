<script lang="ts">
    import { language } from 'src/lang'
    import { DBState } from 'src/ts/stores.svelte'
    import { openSettings, SettingsRoute } from 'src/ts/routing'
    import PresetPickerLayout from './PresetPickerLayout.svelte'
    import PresetBindingTrigger from './PresetBindingTrigger.svelte'
    import PresetPickerActions from './PresetPickerActions.svelte'
    import InlineEditableName from './components/InlineEditableName.svelte'
    import { removePresetTag, togglePresetTag } from 'src/ts/preset/tags'
    import { alertConfirm, alertError, notifyError, notifySuccess } from 'src/ts/alert'
    import { downloadFile } from 'src/ts/globalApi.svelte'
    import {
        appendTranslatorPreset,
        createTranslatorPreset,
        decodeTranslatorPresetFile,
        duplicateTranslatorPreset,
        encodeTranslatorPresetFile,
        getTranslatorPresetDownloadName,
        moveTranslatorPreset,
        removeTranslatorPreset,
        translatorPresetImportExtensions,
    } from 'src/ts/translator/presets'
    import { selectSingleFile } from 'src/ts/util'

    interface Props {
        value?: string
        onChange?: (value: string) => void
        showConfigure?: boolean
        compact?: boolean
        open?: boolean
        onConfigure?: () => void
    }

    let {
        value = $bindable(''),
        onChange = () => {},
        showConfigure = false,
        compact = false,
        open = $bindable(false),
        onConfigure = () => {},
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
        onConfigure()
        openSettings(SettingsRoute.Language)
    }

    function movePreset(fromIndex: number, toIndex: number) {
        moveTranslatorPreset(DBState.db, fromIndex, toIndex)
    }

    function addPreset() {
        const preset = createTranslatorPreset()
        preset.tagIds = undefined
        appendTranslatorPreset(DBState.db, preset)
    }

    function duplicatePreset(index: number) {
        if (duplicateTranslatorPreset(DBState.db, index, language.copy)) {
            notifySuccess(language.presetDuplicated)
        }
    }

    async function removePreset(index: number) {
        if (presets.length <= 1) {
            notifyError(language.errors.onlyOnePreset)
            return
        }
        const preset = presets[index]
        if (!preset || !await alertConfirm(`${language.removeConfirm}${preset.name}`)) return
        removeTranslatorPreset(DBState.db, index)
    }

    async function exportPreset(index: number) {
        try {
            const preset = presets[index]
            if (!preset) return
            await downloadFile(getTranslatorPresetDownloadName(preset.name), await encodeTranslatorPresetFile(preset))
            notifySuccess(language.successExport)
        } catch (error) {
            alertError(`${error}`)
        }
    }

    async function importPreset() {
        try {
            const file = await selectSingleFile(translatorPresetImportExtensions)
            if (!file) return
            const decoded = await decodeTranslatorPresetFile(file.data)
            const preset = createTranslatorPreset(decoded.name, { ...decoded, id: undefined })
            appendTranslatorPreset(DBState.db, preset)
            notifySuccess(language.successImport)
        } catch (error) {
            alertError(`${error}`)
        }
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
        onFoldersChange={(nextTags) => { DBState.db.translatorPresetTags = nextTags }}
        onAssignItem={(index, tagId) => {
            const preset = presets[index]
            if (!preset) return
            DBState.db.translatorPresets = presets.map((item, presetIndex) => presetIndex === index
                ? { ...item, tagIds: togglePresetTag(item.tagIds, tagId) }
                : item)
        }}
        onDeleteFolder={(tagId) => {
            DBState.db.translatorPresets = presets.map(preset => ({
                ...preset,
                tagIds: removePresetTag(preset.tagIds, tagId),
            }))
        }}
        {selectedItemIndex}
        onMoveItem={movePreset}
        onSelectItem={selectPreset}
        onDuplicateItem={duplicatePreset}
        onExportItem={exportPreset}
        onDeleteItem={removePreset}
        itemRenameable
    >
        {#snippet itemContent(index, renameController)}
            <InlineEditableName
                controller={renameController}
                bind:value={DBState.db.translatorPresets[index].name}
                size="default"
                editorLeadingInset="row"
                placeholder="string"
                onActivate={() => selectPreset(index)}
            />
        {/snippet}
        <PresetPickerActions onCreate={addPreset} onImport={importPreset} />
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
