<script lang="ts">
    import { language } from "src/lang";
    import PresetPickerLayout from "src/lib/UI/PresetPickerLayout.svelte";
    import PresetPickerActions from "src/lib/UI/PresetPickerActions.svelte";
    import PresetHeader from "../../../UI/components/PresetHeader.svelte";
    import SettingRenderer from "../../SettingRenderer.svelte";
    import type { SettingItem } from "src/ts/setting/types";
    import InlineEditableName from "../../../UI/components/InlineEditableName.svelte";
    import { alertConfirm, alertError, notifyError, notifySuccess } from "src/ts/alert";
    import { downloadFile } from "src/ts/globalApi.svelte";
    import { DBState } from "src/ts/stores.svelte";
    import {
        appendTranslatorPreset, createTranslatorPreset, decodeTranslatorPresetFile, defaultTranslatorPrompt,
        duplicateTranslatorPreset,
        encodeTranslatorPresetFile, getTranslatorPresetDownloadName,
        moveTranslatorPreset, removeTranslatorPreset, syncCurrentTranslatorPresetToLegacyFields,
    } from "src/ts/translator/presets";
    import { selectSingleImportFile } from "src/ts/util";
    import { removePresetTag, togglePresetTag } from "src/ts/preset/tags";

    let pickerOpen = $state(false);
    let selectedFolder = $state("all");
    let searchQuery = $state("");
    let visibleItemIndexes = $state<number[]>([]);
    let emptyMessage = $state("");

    const tags = $derived(DBState.db.translatorPresetTags ?? []);
    const activePreset = $derived(DBState.db.translatorPresets?.[DBState.db.translatorPresetId]);
    const activePresetItems = $derived.by((): SettingItem[] => activePreset ? [
        {
            id: 'translatorPreset.maxResponse', type: 'slider', labelKey: 'translationResponseSize', helpKey: 'translationResponseSize',
            bindPath: 'maxResponse',
            onChange: sync,
            options: { min: 1, max: 64000, step: 1 },
        },
        {
            id: 'translatorPreset.prompt', type: 'textarea', labelKey: 'translatorPrompt', helpKey: 'translatorPrompt',
            bindPath: 'prompt',
            onChange: sync,
            options: { placeholder: defaultTranslatorPrompt },
        },
    ] : []);

    function sync() {
        syncCurrentTranslatorPresetToLegacyFields(DBState.db);
    }

    function selectPreset(index: number) {
        DBState.db.translatorPresetId = index;
        sync();
        pickerOpen = false;
    }

    function movePreset(fromIndex: number, toIndex: number) {
        moveTranslatorPreset(DBState.db, fromIndex, toIndex);
    }

    function addPreset() {
        const preset = createTranslatorPreset();
        preset.tagIds = undefined;
        appendTranslatorPreset(DBState.db, preset);
    }

    function duplicatePreset(index: number) {
        if (duplicateTranslatorPreset(DBState.db, index, language.copy)) {
            notifySuccess(language.presetDuplicated);
        }
    }

    async function removePreset(index: number) {
        if (DBState.db.translatorPresets.length <= 1) {
            notifyError(language.errors.onlyOnePreset);
            return;
        }
        const preset = DBState.db.translatorPresets[index];
        if (!await alertConfirm(`${language.removeConfirm}${preset.name}`)) return;
        removeTranslatorPreset(DBState.db, index);
    }

    async function exportPreset(index: number) {
        try {
            const preset = DBState.db.translatorPresets[index];
            await downloadFile(getTranslatorPresetDownloadName(preset.name), await encodeTranslatorPresetFile(preset));
            notifySuccess(language.successExport);
        } catch (error) {
            alertError(`${error}`);
        }
    }

    async function importPreset() {
        try {
            const file = await selectSingleImportFile();
            if (!file) return;
            const decoded = await decodeTranslatorPresetFile(file.data);
            const preset = createTranslatorPreset(decoded.name, { ...decoded, id: undefined });
            appendTranslatorPreset(DBState.db, preset);
            notifySuccess(language.successImport);
        } catch (error) {
            alertError(`${error}`);
        }
    }
</script>

<div class="flex items-center justify-between gap-3 py-3 border-t border-darkborderc">
    <div class="flex flex-col gap-0.5 min-w-0">
        <span class="text-sm text-maintext">{language.presets}</span>
        <span class="text-xs text-subtext">{language.help.translatorPreset}</span>
    </div>
    <PresetHeader
        compact
        label={language.presets}
        activeName={activePreset?.name ?? "Default"}
        onManage={() => pickerOpen = true}
    />
</div>

{#if activePreset}
    <SettingRenderer items={activePresetItems} target={activePreset} layout="row" />
{/if}

{#if pickerOpen}
    <PresetPickerLayout
        title={`${language.translate} ${language.presets}`}
        folders={tags}
        itemFolderIds={DBState.db.translatorPresets.map(preset => preset.tagIds)}
        organizationKind="tag"
        itemNames={DBState.db.translatorPresets.map(preset => preset.name)}
        itemDragDataKey="translatorPresetIndex"
        bind:selectedFolder bind:searchQuery bind:visibleItemIndexes bind:emptyMessage
        close={() => pickerOpen = false}
        onFoldersChange={(next) => DBState.db.translatorPresetTags = next}
        onAssignItem={(index, tagId) => {
            const preset = DBState.db.translatorPresets[index];
            preset.tagIds = togglePresetTag(preset.tagIds, tagId);
            DBState.db.translatorPresets = [...DBState.db.translatorPresets];
        }}
        onDeleteFolder={(tagId) => {
            DBState.db.translatorPresets = DBState.db.translatorPresets.map(preset =>
                ({ ...preset, tagIds: removePresetTag(preset.tagIds, tagId) }));
        }}
        selectedItemIndex={DBState.db.translatorPresetId}
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
        <PresetPickerActions
            onCreate={addPreset}
            onImport={importPreset}
        />
    </PresetPickerLayout>
{/if}
