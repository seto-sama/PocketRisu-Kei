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
    import InlineEditableName from "../UI/components/InlineEditableName.svelte";
    import PresetPickerLayout from "../UI/PresetPickerLayout.svelte";
    import PresetPickerActions from "../UI/PresetPickerActions.svelte";
    import { updateColorScheme, updateTextThemeAndCSS } from "src/ts/gui/colorscheme";
    import { updateAnimationSpeed } from "src/ts/gui/animation";
    import { updateGuisize } from "src/ts/gui/guisize";
    import { removePresetTag, togglePresetTag } from "src/ts/preset/tags";

    let selectedFolder = $state('all');

    const tags = $derived(DBState.db.themePresetTags ?? []);

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

    function assignPresetToTag(index: number, tagId: string | undefined) {
        const preset = DBState.db.themePresets[index];
        if (!preset) return;
        preset.tagIds = togglePresetTag(preset.tagIds, tagId);
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
            notifyError(language.errors.onlyOnePreset);
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
    folders={tags}
    itemFolderIds={DBState.db.themePresets.map(preset => preset.tagIds)}
    organizationKind="tag"
    itemNames={DBState.db.themePresets.map(preset => preset.name ?? '')}
    bind:selectedFolder
    itemDragDataKey="presetIndex"
    {close}
    onFoldersChange={(next) => { DBState.db.themePresetTags = next }}
    onAssignItem={assignPresetToTag}
    onDeleteFolder={(tagId) => {
        DBState.db.themePresets = DBState.db.themePresets.map(preset =>
            ({ ...preset, tagIds: removePresetTag(preset.tagIds, tagId) })
        )
    }}
    selectedItemIndex={DBState.db.themePresetsId}
    onMoveItem={movePreset}
    onSelectItem={selectPreset}
    onDuplicateItem={copyThemePreset}
    onExportItem={(index) => downloadThemePreset(index, 'json')}
    onDeleteItem={deletePreset}
    itemRenameable
>
    {#snippet itemContent(index, renameController)}
        <InlineEditableName
            controller={renameController}
            bind:value={DBState.db.themePresets[index].name}
            size="default"
            editorLeadingInset="row"
            placeholder="string"
            onActivate={() => selectPreset(index)}
        />
    {/snippet}

    <PresetPickerActions
        onCreate={() => {
            const newPreset = safeStructuredClone(themePresetTemplate);
            newPreset.name = 'New Theme';
            newPreset.tagIds = undefined;
            DBState.db.themePresets = [...DBState.db.themePresets, newPreset];
        }}
        onImport={async () => {
            await importThemePreset();
        }}
    />
</PresetPickerLayout>
