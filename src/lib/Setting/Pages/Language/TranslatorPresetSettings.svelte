<script lang="ts">
    import { language } from "src/lang";
    import PresetPickerLayout from "src/lib/UI/PresetPickerLayout.svelte";
    import PresetPickerActions from "src/lib/UI/PresetPickerActions.svelte";
    import PresetHeader from "src/lib/UI/GUI/PresetHeader.svelte";
    import SettingRenderer from "../../SettingRenderer.svelte";
    import type { SettingItem } from "src/ts/setting/types";
    import TextInput from "src/lib/UI/GUI/TextInput.svelte";
    import { alertConfirm, alertError, notifyError, notifySuccess } from "src/ts/alert";
    import { downloadFile } from "src/ts/globalApi.svelte";
    import { DBState } from "src/ts/stores.svelte";
    import {
        createTranslatorPreset, decodeTranslatorPresetFile, defaultTranslatorPrompt,
        encodeTranslatorPresetFile, getTranslatorPresetDownloadName,
        normalizeTranslatorPresetState, syncCurrentTranslatorPresetToLegacyFields,
        translatorPresetImportExtensions,
    } from "src/ts/translator/presets";
    import { selectSingleFile } from "src/ts/util";

    let pickerOpen = $state(false);
    let editMode = $state(false);
    let selectedFolder = $state("all");
    let searchQuery = $state("");
    let visibleItemIndexes = $state<number[]>([]);
    let emptyMessage = $state("");

    const folders = $derived(DBState.db.translatorPresetFolders ?? []);
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
        const presets = DBState.db.translatorPresets;
        if (fromIndex === toIndex || fromIndex < 0 || toIndex < 0 || fromIndex >= presets.length || toIndex > presets.length) return;
        const next = [...presets];
        const [moved] = next.splice(fromIndex, 1);
        if (!moved) return;
        const target = fromIndex < toIndex ? toIndex - 1 : toIndex;
        next.splice(target, 0, moved);
        const current = DBState.db.translatorPresetId;
        if (current === fromIndex) DBState.db.translatorPresetId = target;
        else if (fromIndex < current && target >= current) DBState.db.translatorPresetId = current - 1;
        else if (fromIndex > current && target <= current) DBState.db.translatorPresetId = current + 1;
        DBState.db.translatorPresets = next;
        sync();
    }

    function addPreset() {
        const preset = createTranslatorPreset();
        preset.folderId = selectedFolder !== "all" && selectedFolder !== "uncategorized"
            ? selectedFolder : undefined;
        DBState.db.translatorPresets = [...DBState.db.translatorPresets, preset];
        DBState.db.translatorPresetId = DBState.db.translatorPresets.length - 1;
        normalizeTranslatorPresetState(DBState.db);
    }

    function duplicatePreset(index: number) {
        const preset = safeStructuredClone(DBState.db.translatorPresets[index]);
        preset.name = `${preset.name} Copy`;
        DBState.db.translatorPresets = [...DBState.db.translatorPresets, preset];
        DBState.db.translatorPresetId = DBState.db.translatorPresets.length - 1;
        normalizeTranslatorPresetState(DBState.db);
        notifySuccess(language.presetDuplicated);
    }

    async function removePreset(index: number) {
        if (DBState.db.translatorPresets.length <= 1) {
            notifyError("There must be at least one preset.");
            return;
        }
        const preset = DBState.db.translatorPresets[index];
        if (!await alertConfirm(`${language.removeConfirm}${preset.name}`)) return;
        DBState.db.translatorPresets = DBState.db.translatorPresets.filter((_, i) => i !== index);
        DBState.db.translatorPresetId = Math.min(DBState.db.translatorPresetId, DBState.db.translatorPresets.length - 1);
        normalizeTranslatorPresetState(DBState.db);
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
            const file = await selectSingleFile(translatorPresetImportExtensions);
            if (!file) return;
            const preset = await decodeTranslatorPresetFile(file.data);
            preset.folderId = selectedFolder !== "all" && selectedFolder !== "uncategorized"
                ? selectedFolder : undefined;
            DBState.db.translatorPresets = [...DBState.db.translatorPresets, preset];
            DBState.db.translatorPresetId = DBState.db.translatorPresets.length - 1;
            normalizeTranslatorPresetState(DBState.db);
            notifySuccess(language.successImport);
        } catch (error) {
            alertError(`${error}`);
        }
    }
</script>

<div class="flex items-center justify-between gap-3 py-3 border-t border-darkborderc">
    <div class="flex flex-col gap-0.5 min-w-0">
        <span class="text-sm text-textcolor">{language.presets}</span>
        <span class="text-xs text-textcolor2">{language.help.translatorPreset}</span>
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
        {folders}
        itemFolderIds={DBState.db.translatorPresets.map(preset => preset.folderId)}
        itemNames={DBState.db.translatorPresets.map(preset => preset.name)}
        itemDragDataKey="translatorPresetIndex"
        bind:selectedFolder bind:searchQuery bind:visibleItemIndexes bind:emptyMessage
        close={() => pickerOpen = false}
        onFoldersChange={(next) => DBState.db.translatorPresetFolders = next}
        onAssignItem={(index, folderId) => {
            const preset = DBState.db.translatorPresets[index];
            preset.folderId = folderId;
            DBState.db.translatorPresets = [...DBState.db.translatorPresets];
        }}
        onDeleteFolder={(folderId) => {
            DBState.db.translatorPresets = DBState.db.translatorPresets.map(preset =>
                preset.folderId === folderId ? { ...preset, folderId: undefined } : preset);
        }}
        selectedItemIndex={DBState.db.translatorPresetId}
        itemEditMode={editMode}
        onMoveItem={movePreset}
        onSelectItem={selectPreset}
        onDuplicateItem={duplicatePreset}
        onExportItem={exportPreset}
        onDeleteItem={removePreset}
    >
        {#snippet itemContent(index)}
                {@const preset = DBState.db.translatorPresets[index]}
                {#if editMode}
                    <div class="min-w-0 grow"><TextInput bind:value={DBState.db.translatorPresets[index].name} placeholder="string" padding={false} fullwidth className="h-8 min-w-0 px-2" /></div>
                {:else}
                    <span class="grow min-w-0 truncate">{preset.name}</span>
                {/if}
        {/snippet}
        <PresetPickerActions
            onCreate={addPreset}
            onImport={importPreset}
            onRename={() => { editMode = !editMode }}
        />
    </PresetPickerLayout>
{/if}
