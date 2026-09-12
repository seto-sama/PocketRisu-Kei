<script lang="ts">
    import { alertConfirm, notifyError } from "../../ts/alert";
    import { language } from "../../lang";
    import {
        changeToThemePreset,
        downloadThemePreset,
        importThemePreset,
        saveCurrentThemePreset,
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
    import { appendPresetItem, clonePresetWithNewId, duplicatePresetItem, movePresetItem, removePresetItem } from "src/ts/preset/collection";

    let selectedFolder = $state('all');

    const tags = $derived(DBState.db.themePresetTags ?? []);

    interface Props {
        close?: () => void;
    }
    let { close = () => {} }: Props = $props();

    function movePreset(fromIndex: number, toIndex: number) {
        const result = movePresetItem(DBState.db.themePresets, DBState.db.themePresetsId, fromIndex, toIndex);
        if (!result.changed) return;
        DBState.db.themePresets = result.items;
        DBState.db.themePresetsId = result.selectedIndex;
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
        saveCurrentThemePreset();
        const result = removePresetItem(DBState.db.themePresets, DBState.db.themePresetsId, index);
        if (!result.changed) return;
        DBState.db.themePresets = result.items;
        changeToThemePreset(result.selectedIndex, false);
        applyThemeVisuals();
    }

    function duplicatePreset(index: number) {
        saveCurrentThemePreset();
        const result = duplicatePresetItem(DBState.db.themePresets, index, source => {
            const copy = clonePresetWithNewId(source);
            copy.name += ` ${language.copy}`;
            return copy;
        });
        if (!result.changed) return;
        DBState.db.themePresets = result.items;
    }

</script>

<PresetPickerLayout
    title={language.themePresets}
    titleHelpKey="themePresets"
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
    onDuplicateItem={duplicatePreset}
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
            const newPreset = clonePresetWithNewId(themePresetTemplate);
            newPreset.name = 'New Theme';
            newPreset.tagIds = undefined;
            DBState.db.themePresets = appendPresetItem(DBState.db.themePresets, newPreset).items;
        }}
        onImport={async () => {
            await importThemePreset();
        }}
    />
</PresetPickerLayout>
