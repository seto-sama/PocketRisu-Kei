<script lang="ts">
    import { getChatBoundPromptPreset } from "src/ts/chatBindingState";
    import { alertConfirm, notifyError, notifySuccess } from "../../ts/alert";
    import { language } from "../../lang";
    import { changeToPreset, copyPreset, downloadPreset, getCurrentChat, importPreset, saveCurrentPreset } from "../../ts/storage/database.svelte";
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
    import { appendPresetItem, movePresetItem, removePresetItem } from "src/ts/preset/collection";
    import { createEntityId } from "src/ts/id";

    let selectedFolder = $state<string>('all')

    const tags = $derived(DBState.db.promptPresetTags ?? [])
    const selectedPresetId = $derived($presetSelectCallback
        ? getChatBoundPromptPreset(DBState.db, getCurrentChat())?.id ?? ''
        : DBState.db.activePromptPresetId)
    const selectedPresetIndex = $derived(selectedPresetId
        ? DBState.db.botPresets.findIndex(preset => preset.id === selectedPresetId)
        : -1)

    function assignPresetToTag(index: number, tagId: string | undefined) {
        DBState.db.botPresets[index].tagIds = togglePresetTag(DBState.db.botPresets[index].tagIds, tagId)
        DBState.db.botPresets = [...DBState.db.botPresets]
    }

    let { open = $bindable(true) }: { open?: boolean } = $props();

    function close() {
        open = false
    }

    // Clear any pending preset-select callback when the modal unmounts,
    // so a stale callback can't fire on a later open.
    $effect(() => {
        return () => {
            presetSelectCallback.set(null);
        };
    });

    let showDiffModal = $state(false)
    let compareMode = $state(false)
    let firstPresetIndex = $state<number | null>(null);
    let secondPresetIndex = $state<number | null>(null);

    function movePreset(fromIndex: number, toIndex: number) {
        const result = movePresetItem(DBState.db.botPresets, -1, fromIndex, toIndex);
        if (!result.changed) return;
        DBState.db.botPresets = result.items;
    }

    function selectPreset(index: number) {
        const id = index < 0 ? '' : DBState.db.botPresets[index]?.id
        if (index >= 0 && !id) return
        const callback = get(presetSelectCallback)
        if (callback) {
            presetSelectCallback.set(null)
            callback(id ?? '')
        } else {
            if (id) changeToPreset(id)
        }
        close()
    }

    function duplicatePreset(index: number) {
        const id = copyPreset(index)
        if (!id) return
        changeToPreset(id)
        notifySuccess(language.presetDuplicated)
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
        const removingActive = preset.id === DBState.db.activePromptPresetId
        const targetIndex = DBState.db.botPresets.findIndex(item => item.id === preset.id)
        const result = removePresetItem(DBState.db.botPresets, -1, targetIndex)
        if (!result.changed) return
        DBState.db.botPresets = result.items
        if (removingActive) DBState.db.activePromptPresetId = ''
        notifySuccess(language.presetDeleted)
    }


    function resetDiffSelection() {
        firstPresetIndex = null;
        secondPresetIndex = null;
    }

    function toggleCompareMode() {
        compareMode = !compareMode;
        resetDiffSelection();
    }

    function selectDiffPreset(index: number) {
        if (firstPresetIndex === index) {
            firstPresetIndex = null
            return
        }

        if (firstPresetIndex === null) {
            firstPresetIndex = index
            return
        }

        secondPresetIndex = index
        showDiffModal = true
    }

    function handlePresetClick(index: number) {
        if (compareMode) selectDiffPreset(index)
        else selectPreset(index)
    }

    function closeDiff() {
        showDiffModal = false;
        compareMode = false;
        resetDiffSelection();
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
        bind:open
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
        selectedItemIndex={compareMode ? (firstPresetIndex ?? -1) : selectedPresetIndex}
        onSelectNone={$presetSelectCallback ? () => selectPreset(-1) : undefined}
        noneSelected={selectedPresetIndex < 0}
        onMoveItem={movePreset}
        onSelectItem={handlePresetClick}
        onDuplicateItem={duplicatePreset}
        onExportItem={downloadPreset}
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
                onActivate={() => handlePresetClick(index)}
            />
        {/snippet}
        <PresetPickerActions
            onCreate={() => {
                let botPresets = DBState.db.botPresets
                let newPreset = structuredClone(prebuiltPresets.OAI2)
                newPreset.id = createEntityId()
                newPreset.name = language.promptPresetNewName
                newPreset.tagIds = undefined
                DBState.db.botPresets = appendPresetItem(botPresets, newPreset).items
            }}
            onImport={async () => {
                const before = DBState.db.botPresets.length
                await importPreset()
                const after = DBState.db.botPresets.length
                if (after > before) {
                    const id = DBState.db.botPresets[after - 1]?.id
                    if (id) {
                        changeToPreset(id)
                        notifySuccess(language.presetImported)
                    }
                }
            }}
        >
            <IconButton
                active={compareMode}
                activeColor="primary"
                title={language.showPromptComparison}
                aria-label={language.showPromptComparison}
                aria-pressed={compareMode}
                onclick={toggleCompareMode}
            >
                <GitCompareIcon />
            </IconButton>
        </PresetPickerActions>
</PresetPickerLayout>

{#if showDiffModal && firstPresetIndex !== null && secondPresetIndex !== null}
  <PromptDiffModal
    {firstPresetIndex}
    {secondPresetIndex}
    onClose={closeDiff}
  />
{/if}
