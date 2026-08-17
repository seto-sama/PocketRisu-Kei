<script lang="ts">
    import { ArrowLeftIcon, CopyIcon, PlusIcon, RefreshCwIcon, TrashIcon, TriangleAlertIcon } from "@lucide/svelte";
    import SettingPage from "src/lib/UI/GUI/SettingPage.svelte";
    import ShAccordion from "src/lib/UI/GUI/ShAccordion.svelte";
    import ShAlert from "src/lib/UI/GUI/ShAlert.svelte";
    import SettingTabs from "src/lib/UI/GUI/SettingTabs.svelte";
    import ShButton from "src/lib/UI/GUI/ShButton.svelte";
    import ShSortableList from "src/lib/UI/GUI/ShSortableList.svelte";
    import SchemaFormRenderer from "src/lib/UI/GUI/SchemaFormRenderer.svelte";
    import TextAreaInput from "src/lib/UI/GUI/TextAreaInput.svelte";
    import SettingRenderer from "../../SettingRenderer.svelte";
    import type { SettingItem } from "src/ts/setting/types";
    import type { RegistryFieldSchema, RegistryUiField, RegistryUiGroup } from "src/ts/preset/types";
    import { tokenizerList } from "src/ts/tokenizer";
    import ModelPresetBasicInfo from "./ModelPresetBasicInfo.svelte";
    import ApiKeyPoolManager from "./ApiKeyPoolManager.svelte";
    import ModelPresetOptions from "./ModelPresetOptions.svelte";
    import { language } from "src/lang";
    import { DBState, ModelPresetListTabIndex, openModelProfileBrowser, modelProfileReplaceTarget, openModelPresetEditId } from "src/ts/stores.svelte";
    import { alertConfirm, notifySuccess, notifyWarning } from "src/ts/alert";
    import { testModelPreset, type ModelPresetTestResult } from "src/ts/process/request/request";
    import {
        getOfficialRegistry,
        getOfficialRegistryId,
        getPresetUpdateStatus,
        isOfficialRegistryId,
        syncRemoteRegistry,
    } from "src/ts/preset/registry";
    import { refreshModelPresetProfile, type ModelPresetProfileRefreshTarget } from "src/ts/preset/profileUpdate";
    import {
        buildPluginRegistry,
        listPluginModels,
        PLUGIN_REGISTRY_ID,
        pluginPresetAbilityDefaults,
    } from "src/ts/preset/pluginModels";
    import { customV3ProviderMetaStore } from "src/ts/plugins/apiV3/v3.svelte";
    import { compileModelPreset } from "src/ts/preset/runtime/compilePreset";
    import { onMount } from "svelte";
    import { v4 as uuidv4 } from "uuid";

    let editingId = $state<string | null>(null);
    let submenu = $state(0);

    // "Test" tab state: a one-shot request through the current preset to verify
    // its credentials/endpoint respond. Reset whenever the edited preset changes.
    let testMessage = $state(language.modelPresetTestDefault);
    let testing = $state(false);
    let testResult = $state<ModelPresetTestResult | null>(null);
    // Top-level page tabs are shared so settings search can open Options.
    let suppressPresetClick = $state(false);
    let refreshingAllPresets = $state(false);

    onMount(() => {
        void syncRemoteRegistry();
    });

    const editingPreset = $derived(
        editingId
            ? DBState.db.modelPresets.find(p => p.id === editingId) ?? null
            : null
    );
    const editingCompiled = $derived.by(() => {
        if (!editingPreset) return undefined;
        try {
            return compileModelPreset(editingPreset);
        } catch {
            return undefined;
        }
    });
    const editingAdapterKind = $derived(editingCompiled?.adapterKind);

    // If the preset being edited disappears (deleted elsewhere), fall back to list.
    $effect(() => {
        if (editingId && !editingPreset) {
            editingId = null;
        }
    });

    // Visibility of the advanced "model abilities" toggles. Image input only when
    // the adapter implements vision wire and the snapshot does not already declare
    // 'vision' (declared profiles auto-send, so the toggle would be redundant).
    // System-prompt folding only for openai-compatible (literal role passthrough);
    // anthropic/gemini extract system natively, so folding would strip their system
    // instruction. Sequence shaping (alternate role / user-first) is adapter-agnostic
    // and shows for every preset. Tool use mirrors the prior gate (moved here from
    // the basic-settings tab).
    const showImageInputToggle = $derived(
        !!editingPreset
        && editingCompiled?.availability.vision === true
        && !(editingPreset.profileSnapshot.capabilities ?? []).includes('vision')
    );
    const showVisionQuality = $derived(
        !!editingPreset
        && (
            (editingPreset.profileSnapshot.capabilities ?? []).includes('vision')
            || editingPreset.imageInput === true
        )
        && editingCompiled?.features.vision === true
    );
    const showFoldToggles = $derived(
        !!editingPreset && editingCompiled?.behavior.canFoldSystemPrompt === true
    );
    const showSequenceToggles = $derived(!!editingPreset);
    const showToolUseToggle = $derived(
        !!editingPreset
        && editingCompiled?.availability.tools === true
    );
    // Gemini context caching section. Gated like the tool-use toggle: the profile
    // must declare the 'cache' capability AND the adapter must be the one that
    // implements the cache wire (google-gemini). v1 main-chat scope; see
    // gemini-cache-keeper-internalization.md §4-3.
    const showCacheSection = $derived(
        !!editingPreset
        && editingCompiled?.availability.cache === true
    );
    const showAnthropicRequestControls = $derived(
        !!editingPreset
        && editingAdapterKind === 'anthropic-messages'
        && editingPreset.profileSnapshot.providerBaseId === 'anthropic'
    );

    const anthropicRequestSchema = $derived.by((): RegistryFieldSchema[] =>
        showAnthropicRequestControls ? [
            {
                key: 'claude1HourCaching',
                type: 'boolean',
                label: language.claude1HourCaching,
                description: language.help.claude1HourCaching,
                default: false,
            },
            {
                key: 'claudeBatching',
                type: 'boolean',
                label: language.claudeBatching,
                description: language.help.claudeBatching,
                default: false,
            },
        ] : []
    );
    const anthropicRequestUiFields = $derived.by((): RegistryUiField[] =>
        showAnthropicRequestControls ? [
            { key: 'claude1HourCaching', widget: 'toggle', visibility: 'advanced', group: 'control', order: 1.1 },
            { key: 'claudeBatching', widget: 'toggle', visibility: 'advanced', group: 'control', order: 1.2 },
        ] : []
    );

    const parameterMaxContext = $derived.by(() => {
        const catalogLimit = editingPreset?.profileSnapshot.limits?.contextWindowTokens;
        return catalogLimit && catalogLimit > 0 ? catalogLimit : 256000;
    });
    const parameterDefaultMaxContext = $derived(
        Math.min(DBState.db.modelPresetDefaultMaxContext ?? 65000, parameterMaxContext)
    );
    const parameterPresetSchema = $derived.by((): RegistryFieldSchema[] =>
        editingPreset ? [
            {
                key: 'maxContext',
                type: 'integer',
                label: 'Max Context Size',
                labelKey: 'maxContextSize',
                helpKey: 'maxContextSize',
                min: 1,
                max: parameterMaxContext,
                step: 1,
            },
        ] : []
    );
    const parameterPresetUiFields = $derived.by((): RegistryUiField[] =>
        parameterPresetSchema.length > 0 ? [
            {
                key: 'maxContext',
                widget: 'slider',
                visibility: 'basic',
                layout: 'row',
                disableable: true,
                group: 'generation',
                order: 0,
                placeholder: String(parameterDefaultMaxContext),
            },
        ] : []
    );

    // Editor-owned model controls join the registry's "capabilities" group so
    // the former "Model abilities" section and provider-declared features are
    // rendered as one ordered feature section. Values still bind to the preset
    // object, not userValues, preserving the existing persisted shape.
    const abilityControls = $derived.by((): {
        schema: RegistryFieldSchema[];
        uiFields: RegistryUiField[];
        groups: RegistryUiGroup[];
    } => {
        if (!editingPreset) return { schema: [], uiFields: [], groups: [] };

        const schema: RegistryFieldSchema[] = [];
        const uiFields: RegistryUiField[] = [];
        const addToggle = (
            key: string,
            label: string,
            labelKey: string,
            helpKey: string,
            order: number,
        ) => {
            schema.push({ key, type: 'boolean', label, labelKey, helpKey, default: false });
            uiFields.push({
                key,
                widget: 'toggle',
                visibility: 'advanced',
                group: 'capabilities',
                order,
            });
        };

        if (showFoldToggles) {
            addToggle('foldSystemPrompt', 'System Role Replacement', 'systemRoleReplacement', 'modelPresetFoldSystemHelp', 1);
        }
        if (showSequenceToggles) {
            addToggle('alternateRole', 'Force Alternating Roles', 'modelPresetAlternateRole', 'modelPresetAlternateRoleHelp', 2);
            addToggle('startWithUserInput', 'Start With User Input', 'modelPresetStartWithUser', 'modelPresetStartWithUserHelp', 3);
        }
        if (showFoldToggles) {
            if (editingPreset.foldSystemPrompt) {
                addToggle('keepFirstSystemPrompt', 'Keep First System Prompt', 'modelPresetKeepFirstSystem', 'modelPresetKeepFirstSystemHelp', 4);
            }
        }
        if (showImageInputToggle) {
            addToggle('imageInput', 'Image Input', 'modelPresetImageInput', 'modelPresetImageInputHelp', 5);
        }
        if (showVisionQuality) {
            schema.push({
                key: 'gptVisionQuality',
                type: 'string',
                label: 'Vision Quality',
                labelKey: 'gptVisionQuality',
                helpKey: 'gptVisionQuality',
                default: 'auto',
                required: true,
                enum: [
                    { value: 'auto', label: 'Auto' },
                    { value: 'low', label: 'Low' },
                    ...(editingAdapterKind === 'google-gemini'
                        ? [{ value: 'medium', label: 'Medium' }]
                        : []),
                    { value: 'high', label: 'High' },
                ],
            });
            uiFields.push({
                key: 'gptVisionQuality',
                widget: 'select',
                visibility: 'advanced',
                layout: 'row',
                group: 'capabilities',
                order: 5.1,
            });
        }
        if (showToolUseToggle) {
            addToggle('toolUse', 'Tool Use', 'modelPresetToolUse', 'modelPresetToolUseHelp', 14.1);
        }

        return {
            schema,
            uiFields,
            groups: schema.length > 0 ? [{
                id: 'capabilities',
                label: 'Features',
                labelKey: 'modelPresetFeaturesGroup',
                order: 3,
            }] : [],
        };
    });

    const advancedExtraGroups = $derived.by((): RegistryUiGroup[] => [
        ...abilityControls.groups,
        {
            id: 'flags',
            label: 'Custom Flags',
            labelKey: 'modelPresetCustomFlagsGroup',
            order: 4,
        },
        ...(showAnthropicRequestControls ? [{
            id: 'control',
            label: 'Controls',
            labelKey: 'modelPresetControlsGroup',
            order: 2.5,
        }] : []),
    ]);

    const cacheItems = $derived.by((): SettingItem[] => editingPreset ? [
        { id: 'modelPreset.cache.enabled', type: 'check', labelKey: 'modelPresetCacheEnable', helpKey: 'modelPresetCacheEnableHelp', bindPath: 'promptCaching.enabled', options: { defaultValue: false } },
        { id: 'modelPreset.cache.ttl', type: 'number', labelKey: 'modelPresetCacheTtl', helpKey: 'modelPresetCacheTtlHelp', condition: () => !!editingPreset.promptCaching?.enabled, bindPath: 'promptCaching.ttlSec', options: { min: 1, placeholder: '600', defaultValue: 600 } },
        { id: 'modelPreset.cache.extend', type: 'check', labelKey: 'modelPresetCacheExtend', helpKey: 'modelPresetCacheExtendHelp', condition: () => !!editingPreset.promptCaching?.enabled, bindPath: 'promptCaching.extendTtlOnHit', options: { defaultValue: true } },
        { id: 'modelPreset.cache.minTokens', type: 'number', labelKey: 'modelPresetCacheMinTokens', helpKey: 'modelPresetCacheMinTokensHelp', condition: () => !!editingPreset.promptCaching?.enabled, bindPath: 'promptCaching.minPromptTokens', options: { min: 1, placeholder: '4096', defaultValue: 4096 } },
        { id: 'modelPreset.cache.growthTokens', type: 'number', labelKey: 'modelPresetCacheGrowth', helpKey: 'modelPresetCacheGrowthHelp', condition: () => !!editingPreset.promptCaching?.enabled, bindPath: 'promptCaching.growthTokens', options: { min: 1, placeholder: '4096', defaultValue: 4096 } },
    ] : []);

    const advancedPresetItems = $derived.by((): SettingItem[] => editingPreset ? [
        {
            id: 'modelPreset.tokenizer', type: 'select', labelKey: 'tokenizerOverride', helpKey: 'tokenizerOverrideHelp',
            bindPath: 'tokenizerOverride',
            options: { defaultValue: '', selectOptions: [{ value: '', label: `${language.tokenizerAuto}${editingPreset.profileSnapshot.recommendedTokenizer ? ` (${editingPreset.profileSnapshot.recommendedTokenizer})` : ''}` }, ...tokenizerList.map(([value, label]) => ({ value, label }))] },
        },
        { id: 'modelPreset.additionalParams', type: 'textarea', labelKey: 'additionalParams', helpKey: 'additionalParamsHelp', bindPath: 'additionalParamsText', options: { defaultValue: '', placeholder: 'reasoning=json::{"effort":"max"}\nheader::X-Trace-Id=abc' } },
    ] : []);

    // Open a freshly-created preset directly in its editor.
    $effect(() => {
        if ($openModelPresetEditId) {
            editingId = $openModelPresetEditId;
            submenu = 0;
            openModelPresetEditId.set(null);
        }
    });

    function duplicate(index: number) {
        const src = DBState.db.modelPresets[index];
        if (!src) return;
        const copy = safeStructuredClone(src);
        copy.id = uuidv4();
        copy.name = `${src.name} Copy`;
        copy.createdAt = Date.now();
        copy.updatedAt = Date.now();
        DBState.db.modelPresets = [...DBState.db.modelPresets, copy];
        notifySuccess(language.presetDuplicated);
    }

    async function remove(index: number) {
        const preset = DBState.db.modelPresets[index];
        if (!preset) return;
        const ok = await alertConfirm(`${language.removeConfirm}${preset.name}`);
        if (!ok) return;
        const next = [...DBState.db.modelPresets];
        next.splice(index, 1);
        DBState.db.modelPresets = next;
        notifySuccess(language.presetDeleted);
    }

    function endPresetDrag() {
        setTimeout(() => {
            suppressPresetClick = false;
        }, 0);
    }

    function createNew() {
        modelProfileReplaceTarget.set(null);
        openModelProfileBrowser.set(true);
    }

    async function refreshAllPresetProfiles() {
        if (refreshingAllPresets) return;
        if (!(await alertConfirm(language.modelPresetRefreshAllConfirm))) return;

        refreshingAllPresets = true;
        try {
            // Force a download even when the catalog content/version markers
            // appear current. UI-only profile revisions may keep those markers.
            const syncResult = await syncRemoteRegistry(true);
            const officialRegistry = getOfficialRegistry();
            const officialRegistryId = getOfficialRegistryId();
            const pluginRegistry = buildPluginRegistry(
                listPluginModels(customV3ProviderMetaStore),
                language.pluginModelProfileDescription,
            );
            const now = Date.now();
            let updatedCount = 0;
            let skippedCount = 0;

            DBState.db.modelPresets = DBState.db.modelPresets.map((preset) => {
                let target: ModelPresetProfileRefreshTarget | undefined;
                const source = preset.sourceProfile;

                if (source?.registryId) {
                    const official = isOfficialRegistryId(source.registryId);
                    const registry = official
                        ? officialRegistry
                        : DBState.db.modelProfileRegistryCache;
                    if (registry) {
                        target = {
                            registry,
                            registryId: official ? officialRegistryId : source.registryId,
                            profileId: source.profileId,
                        };
                    }
                } else if (preset.profileSnapshot.adapterKind === 'plugin') {
                    target = {
                        registry: pluginRegistry,
                        registryId: PLUGIN_REGISTRY_ID,
                        profileId: preset.profileSnapshot.profileId,
                        transient: true,
                    };
                } else {
                    // Backfill old self-contained presets that predate
                    // sourceProfile by their stable snapshot profile id.
                    const profileId = preset.profileSnapshot.profileId;
                    if (officialRegistry.registries[officialRegistryId]?.profiles?.[profileId]) {
                        target = {
                            registry: officialRegistry,
                            registryId: officialRegistryId,
                            profileId,
                        };
                    } else {
                        const customRegistry = DBState.db.modelProfileRegistryCache;
                        const customRegistryId = customRegistry
                            ? Object.keys(customRegistry.registries).find((registryId) =>
                                !!customRegistry.registries[registryId]?.profiles?.[profileId]
                            )
                            : undefined;
                        if (customRegistry && customRegistryId) {
                            target = {
                                registry: customRegistry,
                                registryId: customRegistryId,
                                profileId,
                            };
                        }
                    }
                }

                if (!target) {
                    skippedCount += 1;
                    return preset;
                }

                try {
                    const refreshed = refreshModelPresetProfile(preset, target, { now: () => now });
                    if (!refreshed) {
                        skippedCount += 1;
                        return preset;
                    }
                    updatedCount += 1;
                    return target.transient
                        ? {
                            ...refreshed.preset,
                            ...pluginPresetAbilityDefaults(
                                refreshed.preset.profileSnapshot.modelId,
                                customV3ProviderMetaStore,
                            ),
                        }
                        : refreshed.preset;
                } catch {
                    skippedCount += 1;
                    return preset;
                }
            });

            const descriptions = [
                skippedCount > 0
                    ? language.modelPresetRefreshAllSkipped.replace('{count}', String(skippedCount))
                    : '',
                !syncResult.ok ? language.modelPresetRefreshAllSyncFailed : '',
            ].filter(Boolean);

            if (updatedCount > 0) {
                notifySuccess(
                    language.modelPresetRefreshAllSuccess.replace('{count}', String(updatedCount)),
                    descriptions.length > 0 ? { description: descriptions.join(' ') } : undefined,
                );
            } else {
                notifyWarning(language.modelPresetRefreshAllNone, {
                    description: descriptions.join(' ') || undefined,
                });
            }
        } finally {
            refreshingAllPresets = false;
        }
    }

    // Clear any prior test result when the edited preset changes.
    $effect(() => {
        editingId;
        testResult = null;
    });

    async function runTest() {
        if (!editingPreset || testing || testMessage.trim().length === 0) return;
        testing = true;
        testResult = null;
        try {
            testResult = await testModelPreset(editingPreset, testMessage);
        } catch (err) {
            testResult = { ok: false, message: err instanceof Error ? err.message : String(err), latencyMs: 0 };
        } finally {
            testing = false;
        }
    }
</script>

<SettingPage title={language.modelPresetMenu}>
    {#if editingId}
        <ShButton variant="ghost" size="sm" className="mb-4 self-start" onclick={() => { editingId = null }}>
            <ArrowLeftIcon/>
            <span class="ml-1">{language.backToList}</span>
        </ShButton>

        <SettingTabs
            tabs={[
                { label: language.basicInfo, value: 0 },
                { label: language.basicSettings, value: 1 },
                { label: language.advancedSettings, value: 2 },
                { label: language.modelPresetTabTest, value: 3 },
            ]}
            bind:selected={submenu}
        />

        {#if editingPreset}
            {#if submenu === 0}
                <ModelPresetBasicInfo preset={editingPreset} onAfterDelete={() => { editingId = null }} />
            {:else if submenu === 1}
                <SchemaFormRenderer
                    schema={editingPreset.profileSnapshot.schema}
                    uiSchema={editingPreset.profileSnapshot.uiSchema}
                    userValues={editingPreset.userValues}
                    visibility="basic"
                    preset={editingPreset}
                    extraSchema={parameterPresetSchema}
                    extraUiFields={parameterPresetUiFields}
                    extraValues={editingPreset}
                />
            {:else if submenu === 2}
                {#if showCacheSection}
                    <div class="mb-6">
                        <h3 class="text-sm font-semibold text-textcolor2 uppercase tracking-wide">{language.modelPresetCacheSection}</h3>
                        <SettingRenderer items={cacheItems.slice(0, 3)} target={editingPreset} layout="row" />
                        <ShAlert variant="warning">
                            {#snippet icon()}<TriangleAlertIcon />{/snippet}
                            {language.modelPresetCachePluginWarning}
                        </ShAlert>
                        {#if editingPreset.promptCaching?.enabled}
                            <ShAccordion name={language.modelPresetCacheAdvanced} variant="card" class="ml-4">
                                <div class="p-2"><SettingRenderer items={cacheItems.slice(3)} target={editingPreset} layout="row" /></div>
                            </ShAccordion>
                        {/if}
                    </div>
                {/if}
                <SchemaFormRenderer
                    schema={editingPreset.profileSnapshot.schema}
                    uiSchema={editingPreset.profileSnapshot.uiSchema}
                    userValues={editingPreset.userValues}
                    visibility="advanced"
                    preset={editingPreset}
                    extraSchema={[...abilityControls.schema, ...anthropicRequestSchema]}
                    extraUiGroups={advancedExtraGroups}
                    extraUiFields={[...abilityControls.uiFields, ...anthropicRequestUiFields]}
                    extraValues={editingPreset}
                />
                <div class="mt-6">
                    <h3 class="text-base font-bold mb-1 text-textcolor">{language.modelPresetOtherGroup}</h3>
                    <SettingRenderer items={advancedPresetItems} target={editingPreset} layout="row" />
                </div>
            {:else if submenu === 3}
                <div class="flex flex-col gap-4 mb-6">
                    <div class="flex flex-col gap-0.5">
                        <span class="text-sm text-textcolor">{language.modelPresetTestTitle}</span>
                        <span class="text-xs text-textcolor2">{language.help.modelPresetTestHelp}</span>
                    </div>
                    <TextAreaInput
                        bind:value={testMessage}
                        placeholder={language.modelPresetTestDefault}
                        fullwidth
                        autocomplete="off"
                        height="24"
                    />
                    <ShButton
                        variant="default"
                        size="default"
                        className="self-start"
                        disabled={testing || testMessage.trim().length === 0}
                        onclick={runTest}
                    >
                        {testing ? language.modelPresetTestSending : language.modelPresetTestSend}
                    </ShButton>

                    {#if testResult}
                        <div class="flex flex-col gap-1 rounded-md border p-3 text-sm {testResult.ok ? 'bg-success/20 border-success/40' : 'bg-draculared/20 border-draculared/40'}">
                            <span class="font-medium {testResult.ok ? 'text-success' : 'text-draculared'}">
                                {testResult.ok ? language.modelPresetTestSuccess : language.modelPresetTestFail}
                                <span class="text-textcolor2 font-normal ml-1">({testResult.latencyMs}ms)</span>
                            </span>
                            <span class="text-textcolor whitespace-pre-wrap warp-break-words">{testResult.message}</span>
                        </div>
                    {/if}
                </div>
            {/if}
        {/if}
    {:else}
        <SettingTabs
            tabs={[
                { label: language.modelPresetTabPresets, value: 0 },
                { label: language.apiKeyManagerMenu, value: 1 },
                { label: language.modelPresetTabOptions, value: 2 },
            ]}
            bind:selected={$ModelPresetListTabIndex}
        />

        {#if $ModelPresetListTabIndex === 1}
            <ApiKeyPoolManager />
        {:else if $ModelPresetListTabIndex === 2}
            <ModelPresetOptions />
        {:else}
            <div class="flex gap-2 mb-4">
                <ShButton variant="default" size="default" className="flex-1" onclick={createNew}>
                    <PlusIcon/>
                    <span class="ml-1">{language.modelPresetCreate}</span>
                </ShButton>
                <ShButton
                    variant="outline"
                    size="icon"
                    onclick={refreshAllPresetProfiles}
                    disabled={refreshingAllPresets}
                    aria-label={language.modelPresetRefreshAll}
                    title={language.modelPresetRefreshAll}
                >
                    <RefreshCwIcon class={refreshingAllPresets ? "animate-spin" : ""} />
                </ShButton>
            </div>

            {#if DBState.db.modelPresets.length === 0}
                <div class="text-textcolor2 text-sm text-center py-8">
                    {language.modelPresetEmpty}
                </div>
            {:else}
                <ShSortableList
                    className="flex flex-col gap-3"
                    dragPreviewText={(id) => DBState.db.modelPresets.find(preset => preset.id === id)?.name}
                    onReorder={(orderedIds) => {
                        const byId = new Map(DBState.db.modelPresets.map(preset => [preset.id, preset]));
                        DBState.db.modelPresets = orderedIds
                            .map(id => byId.get(id))
                            .filter((preset) => preset !== undefined);
                    }}
                    onDragStart={() => { suppressPresetClick = true }}
                    onDragEnd={endPresetDrag}
                >
                    {#each DBState.db.modelPresets as preset, i (preset.id)}
                        <button
                            data-sortable-key={preset.id}
                            class="flex items-center text-textcolor border border-darkborderc rounded-md p-3 risu-interactive-surface transition-colors text-left"
                            onclick={() => {
                                if (suppressPresetClick) return;
                                editingId = preset.id;
                                submenu = 0;
                            }}
                        >
                            <div class="flex flex-col min-w-0 grow">
                                <span class="text-sm text-textcolor truncate flex items-center gap-1.5">
                                    {#if getPresetUpdateStatus(preset) === 'updatable'}
                                        <span class="w-2 h-2 rounded-full bg-highlight shrink-0" title={language.profileUpdateAvailable}></span>
                                    {/if}
                                    <span class="truncate">{preset.name}</span>
                                </span>
                                {#if preset.profileSnapshot?.profileId}
                                    <span class="text-xs text-textcolor2 truncate">{preset.profileSnapshot.profileId}</span>
                                {/if}
                            </div>
                            <div class="no-sort flex gap-2 shrink-0 ml-2">
                                <div class="text-textcolor2 risu-interactive-accent cursor-pointer" role="button" tabindex="0" onclick={(e) => {
                                    e.stopPropagation()
                                    duplicate(i)
                                }} onkeydown={(e) => {
                                    if (e.key === 'Enter' && e.currentTarget instanceof HTMLElement) {
                                        e.currentTarget.click()
                                    }
                                }} aria-label="duplicate">
                                    <CopyIcon size={18}/>
                                </div>
                                <div class="text-textcolor2 risu-interactive-danger cursor-pointer" role="button" tabindex="0" onclick={(e) => {
                                    e.stopPropagation()
                                    remove(i)
                                }} onkeydown={(e) => {
                                    if (e.key === 'Enter' && e.currentTarget instanceof HTMLElement) {
                                        e.currentTarget.click()
                                    }
                                }} aria-label="delete">
                                    <TrashIcon size={18}/>
                                </div>
                            </div>
                        </button>
                    {/each}
                </ShSortableList>
            {/if}
        {/if}
    {/if}
</SettingPage>
