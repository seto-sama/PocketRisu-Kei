<script lang="ts">
    import { alertConfirm, notifyError, notifySuccess } from "../../ts/alert";
    import { language } from "../../lang";
    import { changeToPreset, copyPreset, downloadPreset, importPreset, saveCurrentPreset, withStableActivePreset } from "../../ts/storage/database.svelte";
    import { v4 as uuidv4 } from "uuid";
    import { DBState, presetSelectCallback, settingsOpen } from 'src/ts/stores.svelte';
    import { get } from 'svelte/store';
    import { openSettings, SettingsRoute } from 'src/ts/routing';
    import { GitCompare } from "@lucide/svelte";
    import TextInput from "../UI/GUI/TextInput.svelte";
    import { prebuiltPresets } from "src/ts/process/templates/templates";
    import PromptDiffModal from "../Others/PromptDiffModal.svelte";
    import PresetPickerLayout from "../UI/PresetPickerLayout.svelte";
    import PresetPickerActions from "../UI/PresetPickerActions.svelte";

    let editMode = $state(false)
    let selectedFolder = $state<string>('all')

    const folders = $derived(DBState.db.promptPresetFolders ?? [])

    function assignPresetToFolder(index: number, folder: string | undefined) {
        DBState.db.botPresets[index].folderId =
            folder === 'all' || folder === 'uncategorized' ? undefined : folder
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
        {folders}
        itemFolderIds={DBState.db.botPresets.map(preset => preset.folderId)}
        itemNames={DBState.db.botPresets.map(preset => preset.name ?? '')}
        bind:selectedFolder
        itemDragDataKey="presetIndex"
        {close}
        configure={!$settingsOpen ? () => {
                close()
                openSettings(SettingsRoute.PromptPreset)
            } : undefined}
        configureLabel={language.presetEdit}
        onFoldersChange={(next) => { DBState.db.promptPresetFolders = next }}
        onAssignItem={assignPresetToFolder}
        onDeleteFolder={(folderId) => {
            DBState.db.botPresets = DBState.db.botPresets.map(preset =>
                preset.folderId === folderId ? { ...preset, folderId: undefined } : preset
            )
        }}
        selectedItemIndex={DBState.db.botPresetsId}
        itemEditMode={editMode}
        onMoveItem={movePreset}
        onSelectItem={selectPreset}
        onDuplicateItem={duplicatePreset}
        onExportItem={exportPreset}
        onDeleteItem={deletePreset}
    >
        {#snippet itemContent(index)}
            {@const preset = DBState.db.botPresets[index]}
            {#if editMode}
                <div class="min-w-0 grow">
                    <TextInput bind:value={DBState.db.botPresets[index].name} placeholder="string" padding={false} fullwidth className="h-8 min-w-0 px-2" />
                </div>
            {:else}
                {#if preset.image}
                    <img src={preset.image} alt="icon" class="mr-2 min-w-6 min-h-6 w-6 h-6 rounded-md" decoding="async"/>
                {/if}
                <span class="min-w-0 grow truncate">{preset.name}</span>
            {/if}
            {#if DBState.db.showPromptComparison}
                <button type="button" class="ml-3 shrink-0 {selectedDiffPreset === index ? 'text-green-500' : 'text-textcolor2 hover:text-primary'} cursor-pointer" onclick={(e) => {
                    e.stopPropagation()
                    handleDiffMode(index)
                }}>
                    <GitCompare size={18}/>
                </button>
            {/if}
        {/snippet}
        <PresetPickerActions
            onCreate={() => {
                let botPresets = DBState.db.botPresets
                let newPreset = safeStructuredClone(prebuiltPresets.OAI2)
                newPreset.id = uuidv4()
                newPreset.name = `New Preset`
                newPreset.folderId = selectedFolder !== 'all' && selectedFolder !== 'uncategorized' ? selectedFolder : undefined
                botPresets.push(newPreset)

                DBState.db.botPresets = botPresets
            }}
            onImport={async () => {
                const before = DBState.db.botPresets.length
                await importPreset()
                const after = DBState.db.botPresets.length
                if (after > before) {
                    assignPresetToFolder(after - 1, selectedFolder)
                    changeToPreset(after - 1)
                    notifySuccess(language.presetImported)
                }
            }}
            onRename={() => { editMode = !editMode }}
        />
</PresetPickerLayout>

{#if showDiffModal && firstPresetId !== null && secondPresetId !== null}
  <PromptDiffModal
    firstPresetId={firstPresetId}
    secondPresetId={secondPresetId}
    onClose={closeDiff}
  />
{/if}
