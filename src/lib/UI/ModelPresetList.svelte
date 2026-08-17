<script lang="ts">
    import { DBState, modelProfileReplaceTarget, openModelProfileBrowser } from 'src/ts/stores.svelte';
    import { language } from "src/lang";
    import { alertConfirm, notifySuccess } from "src/ts/alert";
    import { PinIcon, PinOffIcon, TriangleAlert } from "@lucide/svelte";
    import ShButton from "./GUI/ShButton.svelte";
    import PresetHeader from "./GUI/PresetHeader.svelte";
    import PresetPickerLayout from "./PresetPickerLayout.svelte";
    import PresetPickerActions from "./PresetPickerActions.svelte";
    import TextInput from "./GUI/TextInput.svelte";
    import { v4 as uuidv4 } from "uuid";
    import { openSettings, SettingsRoute } from "src/ts/routing";

    interface Props {
        value?: string;
        onChange?: (v: string) => void;
        blankable?: boolean;       // aux slots: empty = "use default sub model"
        blankLabel?: string;
        warnIfEmpty?: boolean;     // main/sub slots: empty = block, show warning
        disabled?: boolean;
        compact?: boolean;
        showConfigure?: boolean;
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
    }: Props = $props();

    let openOptions = $state(false);
    let editMode = $state(false);
    let selectedFolder = $state('all');

    let presets = $derived(DBState.db.modelPresets ?? []);
    let folders = $derived(DBState.db.modelPresetFolders ?? []);
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
        openOptions = false;
        onChange(id);
        // Toast only on binding a real preset, not on clearing to the blank
        // ("use default sub model") option.
        if (id) notifySuccess(language.modelPresetBindedSuccess);
    }

    function goToPresetSettings() {
        openOptions = false;
        openSettings(SettingsRoute.ModelPreset);
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

    function assignPresetToFolder(index: number, folderId: string | undefined) {
        if (!presets[index]) return;
        presets[index].folderId = folderId;
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
        openOptions = false;
        modelProfileReplaceTarget.set(null);
        openModelProfileBrowser.set(true);
    }
</script>

{#if openOptions}
    <PresetPickerLayout
        title={language.modelPresets}
        {folders}
        itemFolderIds={presets.map(preset => preset.folderId)}
        itemNames={presets.map(preset => preset.name)}
        bind:visibleItemIndexes
        bind:selectedFolder
        itemDragDataKey="presetIndex"
        readOnly={showConfigure}
        close={() => { openOptions = false }}
        configure={showConfigure ? goToPresetSettings : undefined}
        onFoldersChange={(next) => { DBState.db.modelPresetFolders = next }}
        onAssignItem={assignPresetToFolder}
        onDeleteFolder={(folderId) => {
            DBState.db.modelPresets = presets.map(preset =>
                preset.folderId === folderId ? { ...preset, folderId: undefined } : preset
            )
        }}
        {selectedItemIndex}
        itemEditMode={editMode}
        onMoveItem={movePreset}
        onSelectItem={(index) => pick(presets[index].id)}
        onDuplicateItem={duplicatePreset}
        onDeleteItem={deletePreset}
    >
        {#snippet itemContent(index)}
            {#if editMode}
                <div class="min-w-0 grow">
                    <TextInput bind:value={DBState.db.modelPresets[index].name} placeholder="string" padding={false} fullwidth className="h-8 min-w-0 px-2" />
                </div>
            {:else}
                <span class="truncate flex-1">{presets[index].name}</span>
            {/if}
        {/snippet}
        {#snippet listFooter()}
            {#if blankable}
                <button
                    class="w-full h-10 flex items-center gap-2 rounded-md text-left px-3 text-sm text-textcolor2 {!value ? '' : 'risu-interactive-surface'}"
                    class:bg-selected={!value}
                    onclick={() => pick('')}
                >
                    <span class="truncate">{blankLabel ?? language.useDefaultSubModel}</span>
                </button>
            {/if}
        {/snippet}
        {#if !showConfigure}
            <PresetPickerActions
                onCreate={createPreset}
                onRename={() => { editMode = !editMode }}
            />
        {/if}
    </PresetPickerLayout>
{/if}

{#if compact}
    <PresetHeader
        compact
        label={language.modelPresetMenu}
        activeName={label}
        onManage={() => { openOptions = true }}
        {disabled}
        variant={(dangling || (warnIfEmpty && !value)) ? 'warning' : 'secondary'}
        className={bound ? 'border-selected text-textcolor'
            : (dangling || (warnIfEmpty && !value)) ? ''
            : 'text-textcolor2 opacity-75 risu-interactive-reveal'}
    />
{:else}
    <ShButton
        variant={(dangling || (warnIfEmpty && !value)) ? 'warning' : 'default'}
        size="default"
        className={`w-full min-w-0 justify-start${disabled ? ' opacity-50 pointer-events-none' : ''} ${
            bound ? 'border-selected text-textcolor'
            : (dangling || (warnIfEmpty && !value)) ? ''
            : 'text-textcolor2 opacity-75 risu-interactive-reveal'
        }`}
        onclick={() => { if (!disabled) { openOptions = true } }}
    >
        {#if bound}
            <PinIcon class="shrink-0" />
        {:else if dangling || (warnIfEmpty && !value)}
            <TriangleAlert size={16} class="shrink-0" />
        {:else}
            <PinOffIcon class="shrink-0" />
        {/if}
        <span class="truncate text-sm grow text-left">{label}</span>
    </ShButton>
{/if}
