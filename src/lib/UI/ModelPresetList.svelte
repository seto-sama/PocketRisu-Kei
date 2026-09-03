<script lang="ts">
    import { DBState, modelProfileReplaceTarget, openModelProfileBrowser } from 'src/ts/stores.svelte';
    import { language } from "src/lang";
    import { alertConfirm, notifySuccess } from "src/ts/alert";
    import PresetBindingTrigger from "./PresetBindingTrigger.svelte";
    import PresetPickerLayout from "./PresetPickerLayout.svelte";
    import PresetPickerActions from "./PresetPickerActions.svelte";
    import InlineEditableName from "./GUI/InlineEditableName.svelte";
    import { v4 as uuidv4 } from "uuid";
    import { ModelPresetTab, openSettings, SettingsRoute } from "src/ts/routing";
    import { removePresetTag, togglePresetTag } from "src/ts/preset/tags";

    interface Props {
        value?: string;
        onChange?: (v: string) => void;
        blankable?: boolean;       // aux slots: empty = "use default sub model"
        blankLabel?: string;
        warnIfEmpty?: boolean;     // main/sub slots: empty = block, show warning
        disabled?: boolean;
        compact?: boolean;
        showConfigure?: boolean;
        open?: boolean;
        pickerOnly?: boolean;
        onConfigure?: () => void;
    }

    let {
        value = $bindable(""),
        onChange = () => {},
        blankable = false,
        blankLabel,
        warnIfEmpty = false,
        disabled = false,
        compact = false,
        showConfigure = false,
        open = $bindable(false),
        pickerOnly = false,
        onConfigure = () => {},
    }: Props = $props();

    let selectedFolder = $state('all');

    let presets = $derived(DBState.db.modelPresets ?? []);
    let tags = $derived(DBState.db.modelPresetTags ?? []);
    let visibleItemIndexes = $state<number[]>([]);
    let bound = $derived(value ? (presets.find(p => p.id === value) ?? null) : null);
    let selectedItemIndex = $derived(value ? presets.findIndex(preset => preset.id === value) : -1);
    // value set but no matching preset → dangling (deleted). Treated as unset by
    // the resolver; surfaced here as a warning so the user can rebind.
    let dangling = $derived(!!value && !bound);

    let label = $derived(
        bound ? bound.name
        : dangling ? language.modelPresetDeleted
        : blankable ? (blankLabel ?? language.useDefaultSubModel)
        : warnIfEmpty ? language.modelPresetUnset
        : language.none
    );

    function pick(id: string) {
        value = id;
        open = false;
        onChange(id);
        // Toast only on binding a real preset, not on clearing to the blank
        // ("use default sub model") option.
        if (id) notifySuccess(language.modelPresetBindedSuccess);
    }

    function goToPresetSettings() {
        open = false;
        onConfigure();
        openSettings(SettingsRoute.ModelPreset, undefined, undefined, ModelPresetTab.Options);
    }

    function movePreset(sourceIndex: number, targetIndex: number) {
        if (sourceIndex === targetIndex || sourceIndex < 0 || targetIndex < 0 || sourceIndex >= presets.length || targetIndex > presets.length) return;
        const next = [...presets];
        const [moved] = next.splice(sourceIndex, 1);
        if (!moved) return;
        const insertionIndex = sourceIndex < targetIndex ? targetIndex - 1 : targetIndex;
        next.splice(insertionIndex, 0, moved);
        DBState.db.modelPresets = next;
    }

    function assignPresetToTag(index: number, tagId: string | undefined) {
        if (!presets[index]) return;
        presets[index].tagIds = togglePresetTag(presets[index].tagIds, tagId);
        DBState.db.modelPresets = [...presets];
    }

    function duplicatePreset(index: number) {
        const source = presets[index];
        if (!source) return;
        const copy = structuredClone($state.snapshot(source));
        copy.id = uuidv4();
        copy.name = `${source.name} Copy`;
        copy.createdAt = Date.now();
        copy.updatedAt = Date.now();
        DBState.db.modelPresets = [...presets, copy];
        notifySuccess(language.presetDuplicated);
    }

    async function deletePreset(index: number) {
        const preset = presets[index];
        if (!preset || !(await alertConfirm(`${language.removeConfirm}${preset.name}`))) return;
        DBState.db.modelPresets = presets.filter((_, presetIndex) => presetIndex !== index);
        notifySuccess(language.presetDeleted);
    }

    function createPreset() {
        open = false;
        modelProfileReplaceTarget.set(null);
        openModelProfileBrowser.set(true);
    }
</script>

{#if open}
    <PresetPickerLayout
        title={language.modelPresets}
        folders={tags}
        itemFolderIds={presets.map(preset => preset.tagIds)}
        organizationKind="tag"
        itemNames={presets.map(preset => preset.name)}
        bind:visibleItemIndexes
        bind:selectedFolder
        itemDragDataKey="presetIndex"
        readOnly={showConfigure}
        close={() => { open = false }}
        configure={showConfigure ? goToPresetSettings : undefined}
        onFoldersChange={(next) => { DBState.db.modelPresetTags = next }}
        onAssignItem={assignPresetToTag}
        onDeleteFolder={(tagId) => {
            DBState.db.modelPresets = presets.map(preset =>
                ({ ...preset, tagIds: removePresetTag(preset.tagIds, tagId) })
            )
        }}
        {selectedItemIndex}
        onMoveItem={movePreset}
        onSelectItem={(index) => pick(presets[index].id)}
        onDuplicateItem={duplicatePreset}
        onDeleteItem={deletePreset}
        itemRenameable
    >
        {#snippet itemContent(index, renameController)}
            <InlineEditableName
                controller={renameController}
                bind:value={DBState.db.modelPresets[index].name}
                size="default"
                placeholder="string"
                disabled={showConfigure}
                onActivate={() => pick(presets[index].id)}
            />
        {/snippet}
        {#snippet listFooter()}
            {#if blankable}
                <button
                    class="w-full h-10 flex items-center gap-2 rounded-md text-left px-3 text-sm text-subtext {!value ? '' : 'risu-interactive-surface'}"
                    class:bg-selected={!value}
                    onclick={() => pick('')}
                >
                    <span class="truncate">{blankLabel ?? language.useDefaultSubModel}</span>
                </button>
            {/if}
        {/snippet}
        {#if !showConfigure}
            <PresetPickerActions onCreate={createPreset} />
        {/if}
    </PresetPickerLayout>
{/if}

{#if !pickerOnly && compact}
    <PresetBindingTrigger
        label={language.modelPresetMenu}
        activeName={label}
        onOpen={() => { open = true }}
        {disabled}
        state={bound ? 'selected' : (dangling || (warnIfEmpty && !value)) ? 'warning' : 'empty'}
        compact
    />
{:else if !pickerOnly}
    <PresetBindingTrigger
        label={language.modelPresetMenu}
        activeName={label}
        onOpen={() => { open = true }}
        {disabled}
        state={bound ? 'selected' : (dangling || (warnIfEmpty && !value)) ? 'warning' : 'empty'}
    />
{/if}
