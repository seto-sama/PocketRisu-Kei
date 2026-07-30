<script lang="ts">
    import { alertConfirm, notifyError } from "../../ts/alert";
    import { language } from "../../lang";
    import {
        changeToThemePreset,
        copyThemePreset,
        downloadThemePreset,
        importThemePreset,
        themePresetTemplate,
    } from "../../ts/storage/database.svelte";
    import { DBState } from 'src/ts/stores.svelte';
    import TextInput from "../UI/GUI/TextInput.svelte";
    import PresetPickerLayout from "../UI/PresetPickerLayout.svelte";
    import PresetPickerActions from "../UI/PresetPickerActions.svelte";
    import { updateColorScheme, updateTextThemeAndCSS } from "src/ts/gui/colorscheme";
    import { updateAnimationSpeed } from "src/ts/gui/animation";
    import { updateGuisize } from "src/ts/gui/guisize";

    let editMode = $state(false);
    let selectedFolder = $state('all');

    const folders = $derived(DBState.db.themePresetFolders ?? []);

    interface Props {
        close?: () => void;
    }
    let { close = () => {} }: Props = $props();

    function movePreset(fromIndex: number, toIndex: number) {
        if (fromIndex === toIndex || fromIndex < 0 || toIndex < 0 || fromIndex >= DBState.db.themePresets.length || toIndex > DBState.db.themePresets.length) return;
        const next = [...DBState.db.themePresets];
        const [moved] = next.splice(fromIndex, 1);
        if (!moved) return;
        const adjustedToIndex = fromIndex < toIndex ? toIndex - 1 : toIndex;
        next.splice(adjustedToIndex, 0, moved);

        const current = DBState.db.themePresetsId;
        if (current === fromIndex) DBState.db.themePresetsId = adjustedToIndex;
        else if (fromIndex < current && adjustedToIndex >= current) DBState.db.themePresetsId = current - 1;
        else if (fromIndex > current && adjustedToIndex <= current) DBState.db.themePresetsId = current + 1;
        DBState.db.themePresets = next;
    }

    function assignPresetToFolder(index: number, folderId: string | undefined) {
        const preset = DBState.db.themePresets[index];
        if (!preset) return;
        preset.folderId = folderId === 'all' || folderId === 'uncategorized' ? undefined : folderId;
        DBState.db.themePresets = [...DBState.db.themePresets];
    }

    function applyThemeVisuals() {
        updateColorScheme();
        updateTextThemeAndCSS();
        updateAnimationSpeed();
        updateGuisize();
    }

    function selectPreset(index: number) {
        changeToThemePreset(index);
        applyThemeVisuals();
        close();
    }

    async function deletePreset(index: number) {
        const preset = DBState.db.themePresets[index];
        if (!preset) return;
        if (DBState.db.themePresets.length === 1) {
            notifyError(language.errors.onlyOneChat);
            return;
        }
        if (!await alertConfirm(`${language.removeConfirm}${preset.name}`)) return;
        changeToThemePreset(0);
        applyThemeVisuals();
        DBState.db.themePresets = DBState.db.themePresets.filter((_, presetIndex) => presetIndex !== index);
        changeToThemePreset(0, false);
        applyThemeVisuals();
    }

</script>

<PresetPickerLayout
    title={language.themePresets}
    {folders}
    itemFolderIds={DBState.db.themePresets.map(preset => preset.folderId)}
    itemNames={DBState.db.themePresets.map(preset => preset.name ?? '')}
    bind:selectedFolder
    itemDragDataKey="presetIndex"
    {close}
    onFoldersChange={(next) => { DBState.db.themePresetFolders = next }}
    onAssignItem={assignPresetToFolder}
    onDeleteFolder={(folderId) => {
        DBState.db.themePresets = DBState.db.themePresets.map(preset =>
            preset.folderId === folderId ? { ...preset, folderId: undefined } : preset
        )
    }}
    selectedItemIndex={DBState.db.themePresetsId}
    itemEditMode={editMode}
    onMoveItem={movePreset}
    onSelectItem={selectPreset}
    onDuplicateItem={copyThemePreset}
    onExportItem={(index) => downloadThemePreset(index, 'json')}
    onDeleteItem={deletePreset}
>
    {#snippet itemContent(index)}
        {@const preset = DBState.db.themePresets[index]}
        {#if editMode}
            <div class="min-w-0 grow">
                <TextInput bind:value={DBState.db.themePresets[index].name} placeholder="string" padding={false} fullwidth className="h-8 min-w-0 px-2" />
            </div>
        {:else}
            <span class="min-w-0 grow truncate">{preset.name}</span>
        {/if}
    {/snippet}

    <PresetPickerActions
        onCreate={() => {
            const newPreset = safeStructuredClone(themePresetTemplate);
            newPreset.name = 'New Theme';
            newPreset.folderId = selectedFolder !== 'all' && selectedFolder !== 'uncategorized' ? selectedFolder : undefined;
            DBState.db.themePresets = [...DBState.db.themePresets, newPreset];
        }}
        onImport={async () => {
            const before = DBState.db.themePresets.length;
            await importThemePreset();
            if (DBState.db.themePresets.length > before) assignPresetToFolder(DBState.db.themePresets.length - 1, selectedFolder);
        }}
        onRename={() => { editMode = !editMode }}
    />
</PresetPickerLayout>
