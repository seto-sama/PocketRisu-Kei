<script lang="ts">
    import { getChatBoundPromptPresetIndex } from "src/ts/chatBindingState";
    import { alertConfirm, notifyError, notifySuccess } from "../../ts/alert";
    import { language } from "../../lang";
    import { changeToPreset, copyPreset, downloadPreset, getCurrentChat, importPreset, saveCurrentPreset, withStableActivePreset } from "../../ts/storage/database.svelte";
    import { createEntityId } from 'src/ts/id';
    import { DBState, presetSelectCallback, settingsOpen } from 'src/ts/stores.svelte';
    import { get } from 'svelte/store';
    import { openSettings, SettingsRoute } from 'src/ts/routing';
    import { GitCompareIcon } from "@lucide/svelte";
    import InlineEditableName from "../UI/components/InlineEditableName.svelte";
    import { prebuiltPresets } from "src/ts/process/templates/templates";
    import PromptDiffModal from "../Others/PromptDiffModal.svelte";
    import PresetPickerLayout from "../UI/PresetPickerLayout.svelte";
    import PresetPickerActions from "../UI/PresetPickerActions.svelte";
    import IconButton from "../UI/components/IconButton.svelte";
    import { removePresetTag, togglePresetTag } from "src/ts/preset/tags";

    let selectedFolder = $state<string>('all')

    const tags = $derived(DBState.db.promptPresetTags ?? [])
    const selectedPresetIndex = $derived($presetSelectCallback
        ? getChatBoundPromptPresetIndex(DBState.db, getCurrentChat())
        : DBState.db.botPresetsId)

    function assignPresetToTag(index: number, tagId: string | undefined) {
        DBState.db.botPresets[index].tagIds = togglePresetTag(DBState.db.botPresets[index].tagIds, tagId)
        DBState.db.botPresets = [...DBState.db.botPresets]
    }

    interface Props {
        close?: () => void;
    }

    let { close = () => {} }: Props = $props();

    // Clear any pending preset-select callback when the modal unmounts,
    // so a stale callback can't fire on a later open.
    $effect(() => {
        return () => {
            presetSelectCallback.set(null);
        };
    });

    let showDiffModal = $state(false)
    let selectedDiffPreset = $state<number | null>(null)
    let firstPresetId = $state<number | null>(null);
    let secondPresetId = $state<number | null>(null);

    function movePreset(fromIndex: number, toIndex: number) {
        if (fromIndex === toIndex) return;
        if (fromIndex < 0 || toIndex < 0 || fromIndex >= DBState.db.botPresets.length || toIndex > DBState.db.botPresets.length) return;

        withStableActivePreset(() => {
            const botPresets = [...DBState.db.botPresets];
            const movedItem = botPresets.splice(fromIndex, 1)[0];
            if (!movedItem) return;
            const adjustedToIndex = fromIndex < toIndex ? toIndex - 1 : toIndex;
            botPresets.splice(adjustedToIndex, 0, movedItem);
            DBState.db.botPresets = botPresets;
        });
    }

    function selectPreset(index: number) {
        const callback = get(presetSelectCallback)
        if (callback) {
            presetSelectCallback.set(null)
            callback(index)
        } else {
            changeToPreset(index)
        }
        close()
    }

    function duplicatePreset(index: number) {
        const before = DBState.db.botPresets.length
        copyPreset(index)
        const after = DBState.db.botPresets.length
        if (after > before) {
            changeToPreset(after - 1)
            notifySuccess(language.presetDuplicated)
        }
    }

    function exportPreset(index: number) {
        downloadPreset(index, 'risupreset')
        notifySuccess(language.presetExported)
    }

    async function deletePreset(index: number) {
        const preset = DBState.db.botPresets[index]
        if (!preset) return
        if (DBState.db.botPresets.length === 1) {
            notifyError(language.errors.onlyOnePreset)
            return
        }
        if (!await alertConfirm(`${language.removeConfirm}${preset.name}`)) return

        // Flush in-flight top-level edits before mutating the preset array.
        saveCurrentPreset()
        const removingActive = index === DBState.db.botPresetsId
        withStableActivePreset(() => {
            const botPresets = DBState.db.botPresets
            botPresets.splice(index, 1)
            DBState.db.botPresets = botPresets
        })
        if (removingActive) changeToPreset(0, false)
        notifySuccess(language.presetDeleted)
    }


    async function handleDiffMode(id: number) {
        if (selectedDiffPreset === id) {
            selectedDiffPreset = null
            firstPresetId = null
            secondPresetId = null
            return
        }
        
        selectedDiffPreset = id

        if (firstPresetId === null) {
            firstPresetId = id
            secondPresetId = null
            return
        }

        secondPresetId = id
        selectedDiffPreset = null
        showDiffModal = true
    }

    function closeDiff() {
        showDiffModal = false;
        firstPresetId = null;
        secondPresetId = null;
        selectedDiffPreset = null;
    }

</script>

<PresetPickerLayout
        title={language.promptPresets}
        folders={tags}
        itemFolderIds={DBState.db.botPresets.map(preset => preset.tagIds)}
        organizationKind="tag"
        itemNames={DBState.db.botPresets.map(preset => preset.name ?? '')}
        bind:selectedFolder
        itemDragDataKey="presetIndex"
        {close}
        configure={!$settingsOpen ? () => {
                close()
                openSettings(SettingsRoute.PromptPreset)
            } : undefined}
        onFoldersChange={(next) => { DBState.db.promptPresetTags = next }}
        onAssignItem={assignPresetToTag}
        onDeleteFolder={(tagId) => {
            DBState.db.botPresets = DBState.db.botPresets.map(preset =>
                ({ ...preset, tagIds: removePresetTag(preset.tagIds, tagId) })
            )
        }}
        selectedItemIndex={selectedPresetIndex}
        onSelectNone={$presetSelectCallback ? () => selectPreset(-1) : undefined}
        noneSelected={selectedPresetIndex < 0}
        onMoveItem={movePreset}
        onSelectItem={selectPreset}
        onDuplicateItem={duplicatePreset}
        onExportItem={exportPreset}
        onDeleteItem={deletePreset}
        itemRenameable
    >
        {#snippet itemContent(index, renameController)}
            {@const preset = DBState.db.botPresets[index]}
            {#if preset.image}
                <img src={preset.image} alt="icon" class="mr-2 min-w-6 min-h-6 w-6 h-6 rounded-md" decoding="async"/>
            {/if}
            <InlineEditableName
                controller={renameController}
                bind:value={DBState.db.botPresets[index].name}
                size="default"
                editorLeadingInset={preset.image ? 'border' : 'row'}
                placeholder="string"
                onActivate={() => selectPreset(index)}
            />
        {/snippet}
        {#snippet itemActions(index)}
            {#if $settingsOpen && DBState.db.showPromptComparison}
                <IconButton
                    active={selectedDiffPreset === index}
                    activeColor="primary"
                    title={language.showPromptComparison}
                    aria-label={language.showPromptComparison}
                    aria-pressed={selectedDiffPreset === index}
                    onclick={() => handleDiffMode(index)}
                >
                    <GitCompareIcon />
                </IconButton>
            {/if}
        {/snippet}
        <PresetPickerActions
            onCreate={() => {
                let botPresets = DBState.db.botPresets
                let newPreset = safeStructuredClone(prebuiltPresets.OAI2)
                newPreset.id = createEntityId()
                newPreset.name = `New Preset`
                newPreset.tagIds = undefined
                botPresets.push(newPreset)

                DBState.db.botPresets = botPresets
            }}
            onImport={async () => {
                const before = DBState.db.botPresets.length
                await importPreset()
                const after = DBState.db.botPresets.length
                if (after > before) {
                    changeToPreset(after - 1)
                    notifySuccess(language.presetImported)
                }
            }}
        />
</PresetPickerLayout>

{#if showDiffModal && firstPresetId !== null && secondPresetId !== null}
  <PromptDiffModal
    firstPresetId={firstPresetId}
    secondPresetId={secondPresetId}
    onClose={closeDiff}
  />
{/if}
