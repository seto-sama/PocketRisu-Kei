<script lang="ts">
    import type { ModelPreset, RegistryFieldSchema, RegistryUiField } from "src/ts/preset/types";
    import { language } from "src/lang";
    import { localizeDescription, localizeFieldLabel } from "src/ts/preset/registry/i18n";
    import { addApiKey, listApiKeys } from "src/ts/preset/apiKeyPool";
    import { untrack } from "svelte";
    import ApiKeyModeControl, { getInitialApiKeyInputMode, type ApiKeyInputMode } from "src/lib/Setting/ApiKeyModeControl.svelte";
    import ShButton from "src/lib/UI/GUI/ShButton.svelte";
    import ShDialog from "src/lib/UI/GUI/ShDialog.svelte";

    interface Props {
        preset: ModelPreset;
        schemaField: RegistryFieldSchema;
        uiField: RegistryUiField;
        userValues: Record<string, unknown>;
    }

    let { preset, schemaField, uiField, userValues = $bindable() }: Props = $props();

    const fieldKey = $derived(schemaField.key);
    const providerBaseId = $derived(preset.profileSnapshot?.providerBaseId);
    const localizedDescription = $derived(localizeDescription(schemaField));
    const localizedLabel = $derived(localizeFieldLabel(schemaField));

    // pool = use a saved key (preset.apiKeyRef); direct = type into userValues.
    // An entirely empty credential starts in pool mode as "none"; only an
    // existing inline value starts in direct mode.
    let mode = $state<ApiKeyInputMode>(untrack(() =>
        getInitialApiKeyInputMode(preset.apiKeyRef, userValues[schemaField.key])
    ));

    const directKey = $derived(userValues[fieldKey]);
    const hasDirectKey = $derived(typeof directKey === 'string' && directKey.length > 0);
    const canShowAllKeys = $derived(preset.profileSnapshot.adapterKind === 'custom');

    const poolEntries = $derived(listApiKeys(canShowAllKeys ? undefined : providerBaseId));

    // Invariant: direct mode never leaves a pool reference behind, or requests
    // would still resolve the pooled key (apiKeyRef wins in buildModelPresetCredential).
    $effect(() => {
        if (mode === 'direct' && preset.apiKeyRef) preset.apiKeyRef = undefined;
    });

    // Dedicated naming dialog. The shared alertInput modal dropped the typed
    // name (focus/IME) and had no empty-name guard, so we own a small dialog
    // here: explicit focus + disabled confirm when empty.
    let showSaveDialog = $state(false);
    let pendingName = $state('');
    let nameInput = $state<HTMLInputElement>();

    $effect(() => {
        if (showSaveDialog && nameInput) {
            const el = nameInput;
            requestAnimationFrame(() => el.focus());
        }
    });

    function openSaveDialog() {
        if (!hasDirectKey) return;
        pendingName = '';
        showSaveDialog = true;
    }

    function selectPoolKey(id: string) {
        preset.apiKeyRef = id || undefined;
    }

    function confirmSave() {
        const key = userValues[fieldKey];
        const name = pendingName.trim();
        if (typeof key !== 'string' || key.length === 0 || !name) return;
        const entry = addApiKey({ name, key, provider: providerBaseId });
        preset.apiKeyRef = entry.id;
        pendingName = '';
        showSaveDialog = false;
        mode = 'pool';
    }
</script>

<div class="flex items-start justify-between gap-3 py-3 border-t border-darkborderc max-sm:flex-col">
    <div class="flex flex-col min-w-0">
        <span class="text-sm text-textcolor flex items-center gap-1">
            {localizedLabel}
            {#if schemaField.required}<span class="text-draculared">*</span>{/if}
        </span>
        <span class="text-xs text-textcolor2 mt-0.5">{language.modelPresetCredentialHelp}</span>
        {#if localizedDescription}
            <span class="text-xs text-textcolor2 mt-0.5">{localizedDescription}</span>
        {/if}
    </div>

    <ApiKeyModeControl
        bind:mode
        entries={poolEntries}
        selectedId={preset.apiKeyRef ?? ''}
        bind:directValue={userValues[fieldKey] as string}
        onSelect={selectPoolKey}
        placeholder={uiField.placeholder ?? ''}
        showProvider={canShowAllKeys}
        showSaveDirect={hasDirectKey}
        onSaveDirect={openSaveDialog}
    />
</div>

<ShDialog bind:open={showSaveDialog} size="sm">
    {#snippet title()}{language.apiKeyNamePrompt}{/snippet}
    <input
        bind:this={nameInput}
        bind:value={pendingName}
        class="border border-darkborderc rounded-md px-3 py-2 text-textcolor bg-transparent focus:border-borderc focus:outline-hidden transition-colors w-full"
        placeholder={language.apiKeyName}
        autocomplete="off"
        onkeydown={(e) => { if (e.key === 'Enter' && !e.isComposing) confirmSave(); }}
    />
    {#snippet footer()}
        <ShButton variant="outline" onclick={() => { showSaveDialog = false; pendingName = ''; }}>{language.cancel}</ShButton>
        <ShButton variant="default" disabled={!pendingName.trim()} onclick={confirmSave}>{language.apiKeyFormSave}</ShButton>
    {/snippet}
</ShDialog>
