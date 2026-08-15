<script lang="ts">
    import { ChevronDownIcon, ChevronRightIcon, DownloadIcon, SearchIcon, TrashIcon, UploadIcon, XIcon } from "@lucide/svelte";
    import { language } from "src/lang";
    import { DBState, modelProfileReplaceTarget, openModelPresetEditId } from "src/ts/stores.svelte";
    import { alertConfirm, alertError, notifySuccess } from "src/ts/alert";
    import { downloadFile } from "src/ts/globalApi.svelte";
    import { selectSingleFile } from "src/ts/util";
    import {
        getOfficialRegistryId,
        getOfficialRegistry,
        getProfileProviderGroup,
        isProfileProviderVisible,
        isProfileVisible,
        listFilterableProviderGroups,
        resolveProviderFilterHiddenIds,
        syncRemoteRegistry,
    } from "src/ts/preset/registry";
    import { createEmptyRegistryCache } from "src/ts/preset/dbDefaults";
    import {
        buildProfileFragment,
        CUSTOM_ID_PREFIX,
        CUSTOM_REGISTRY_ID,
        importFragment,
        removeCustomProfile,
        validateFragment,
    } from "src/ts/preset/customProfiles";
    import {
        createModelPresetFromProfile,
        replaceModelPresetProfile,
    } from "src/ts/preset/profileUpdate";
    import { localizeDisplayName, localizeDescription } from "src/ts/preset/registry/i18n";
    import { getDefaultApiKeyRef } from "src/ts/preset/apiKeyPool";
    import type { BaseProviderDefinition, ModelProfile, RegistryCache, RegistryProfileStatus } from "src/ts/preset/types";
    import { customV3ProviderMetaStore } from "src/ts/plugins/apiV3/v3.svelte";
    import {
        buildPluginRegistry,
        listPluginModels,
        PLUGIN_REGISTRY_ID,
        pluginProfileDisplayId,
        pluginPresetAbilityDefaults,
    } from "src/ts/preset/pluginModels";
    import TextInput from "../UI/GUI/TextInput.svelte";
    import { v4 as uuidv4 } from "uuid";
    import { onMount } from "svelte";

    interface Props {
        close?: any;
    }

    let { close = () => {} }: Props = $props();

    // Developer profiles exist synchronously; the models.dev catalog is
    // hydrated from its separate cache/network at runtime. Plugins merge below.
    const officialRegistry = $derived(getOfficialRegistry());

    onMount(() => {
        void syncRemoteRegistry();
    });

    let activeTab = $state<'official' | 'custom'>('official');
    let query = $state('');

    type Entry = {
        profile: ModelProfile;
        baseProvider: BaseProviderDefinition | undefined;
        registry: RegistryCache;
        registryId: string;
        transientPlugin: boolean;
    };

    const profileStatusOrder: RegistryProfileStatus[] = ['current', 'outdated', 'deprecated'];

    // Active registry by tab. Official = models.dev + Echo (read-only). Custom = the
    // persisted cache's 'custom' registry (reactive: import/delete update it).
    const activeRegistry = $derived<RegistryCache>(
        activeTab === 'official'
            ? officialRegistry
            : (DBState.db.modelProfileRegistryCache ?? createEmptyRegistryCache()),
    );
    const activeRegistryId = $derived(activeTab === 'official' ? getOfficialRegistryId() : CUSTOM_REGISTRY_ID);

    // Scope to the active tab's registry only. The custom cache object can hold
    // multiple imported registries, so iterating all of them would leak profiles
    // into the custom tab.
    function buildEntries(registry: RegistryCache, registryId: string, transientPlugin = false): Entry[] {
        const reg = registry.registries[registryId];
        if (!reg) return [];
        const out: Entry[] = [];
        for (const profile of Object.values(reg.profiles ?? {})) {
            out.push({
                profile,
                baseProvider: reg.baseProviders?.[profile.providerBaseId],
                registry,
                registryId,
                transientPlugin,
            });
        }
        return out.sort((a, b) =>
            (a.baseProvider?.displayName ?? '').localeCompare(b.baseProvider?.displayName ?? '')
            || a.profile.displayName.localeCompare(b.profile.displayName),
        );
    }

    // Only API 3.0 registrations are eligible here. addProvider() also exists
    // in legacy 2.x, but those providers intentionally remain confined to the
    // classic Chat Bot settings. The resulting ModelPreset stores a
    // self-contained snapshot, not this transient registry.
    const pluginRegistry = $derived(buildPluginRegistry(
        listPluginModels(customV3ProviderMetaStore),
        language.pluginModelProfileDescription,
    ));

    // Catalog visibility and provider filters apply to the official models.dev
    // entries only. Custom profiles are the user's own, while Echo and Plugin
    // are special entries — all three stay visible regardless of these filters.
    const entries = $derived.by(() => {
        const all = buildEntries(activeRegistry, activeRegistryId);
        if (activeTab !== 'official') return all;
        const level = DBState.db.modelProfileVisibilityLevel;
        const providerGroups = listFilterableProviderGroups(activeRegistry, activeRegistryId);
        const hiddenProviderIds = resolveProviderFilterHiddenIds(
            providerGroups.map(provider => provider.id),
            DBState.db.modelProfileVisibleProviderIds,
            DBState.db.modelProfileProviderFilterInitialized === true,
            DBState.db.modelProfileHiddenProviderIds,
        );
        return [
            ...all.filter(e =>
                isProfileVisible(e.profile.profileStatus, level)
                && isProfileProviderVisible(e.profile, e.baseProvider, hiddenProviderIds)
            ),
            ...buildEntries(pluginRegistry, PLUGIN_REGISTRY_ID, true),
        ];
    });

    const filtered = $derived.by(() => {
        const q = query.trim().toLowerCase();
        if (!q) return entries;
        return entries.filter(({ profile, baseProvider }) => {
            return profile.displayName.toLowerCase().includes(q)
                || localizeDisplayName(profile).toLowerCase().includes(q)
                || profile.id.toLowerCase().includes(q)
                || profile.modelId.toLowerCase().includes(q)
                || (profile.description ?? '').toLowerCase().includes(q)
                || localizeDescription(profile).toLowerCase().includes(q)
                || (baseProvider?.displayName ?? '').toLowerCase().includes(q)
                || (baseProvider?.id ?? '').toLowerCase().includes(q);
        });
    });

    // Related official APIs can share one vendor group while each profile card
    // still identifies its concrete provider/wire API.
    const groupedByProvider = $derived.by(() => {
        const buckets = new Map<string, { id: string; label: string; entries: Entry[] }>();
        for (const entry of filtered) {
            const group = getProfileProviderGroup(entry.profile, entry.baseProvider);
            let bucket = buckets.get(group.id);
            if (!bucket) {
                bucket = { id: group.id, label: group.label, entries: [] };
                buckets.set(group.id, bucket);
            }
            bucket.entries.push(entry);
        }
        for (const bucket of buckets.values()) {
            bucket.entries.sort((x, y) =>
                profileStatusOrder.indexOf(x.profile.profileStatus) - profileStatusOrder.indexOf(y.profile.profileStatus)
                || ((x.profile.sortOrder ?? 0) - (y.profile.sortOrder ?? 0))
                || localizeDisplayName(x.profile).localeCompare(localizeDisplayName(y.profile)));
        }
        return [...buckets.values()].sort((a, b) => a.label.localeCompare(b.label));
    });

    // Providers default collapsed; an active search force-expands everything so
    // matches are always visible.
    let expandedProviders = $state(new Set<string>());
    const searching = $derived(query.trim() !== '');
    function isProviderExpanded(id: string): boolean {
        return searching || expandedProviders.has(id);
    }
    function toggleProvider(id: string) {
        // Reassign a new Set — Svelte 5 $state does not proxy Set mutations
        // (.add/.delete), so an in-place change wouldn't trigger reactivity.
        const next = new Set(expandedProviders);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        expandedProviders = next;
    }

    function createPresetFrom(entry: Entry) {
        const { profile } = entry;
        const preset = createModelPresetFromProfile({
            registry: entry.registry,
            registryId: entry.registryId,
            profileId: profile.id,
            transient: entry.transientPlugin,
        }, {
            id: uuidv4(),
            apiKeyRef: getDefaultApiKeyRef(profile.providerBaseId),
            abilityDefaults: entry.transientPlugin
                ? pluginPresetAbilityDefaults(profile.modelId, customV3ProviderMetaStore)
                : undefined,
        });
        if (!preset) {
            alertError(language.profileDataIncomplete);
            return;
        }
        DBState.db.modelPresets = [...DBState.db.modelPresets, preset];
        notifySuccess(language.modelPresetCreated);
        openModelPresetEditId.set(preset.id);
        close();
    }

    // Replace an existing preset's profile (custom-profiles plan §3): re-resolve
    // the chosen profile's snapshot, carry over compatible userValues, preserve
    // incompatible values as orphans, seed defaults, and re-stamp sourceProfile.
    async function replacePresetProfile(targetId: string, entry: Entry): Promise<boolean> {
        const { profile } = entry;
        const idx = DBState.db.modelPresets.findIndex((p) => p.id === targetId);
        if (idx < 0) return false;
        const preset = DBState.db.modelPresets[idx];
        const result = replaceModelPresetProfile(preset, {
            registry: entry.registry,
            registryId: entry.registryId,
            profileId: profile.id,
            transient: entry.transientPlugin,
        }, {
            abilityDefaults: entry.transientPlugin
                ? pluginPresetAbilityDefaults(profile.modelId, customV3ProviderMetaStore)
                : undefined,
        });
        if (!result) {
            alertError(language.profileDataIncomplete);
            return false;
        }
        // Replacing the profile can move incompatible settings out of the active
        // form — always confirm, with a stronger warning when that will happen.
        const warn = result.droppedKeys.length > 0 ? language.profileReplaceWarn : language.profileUpdateLossWarn;
        if (!(await alertConfirm(warn))) {
            return false;
        }
        const next = [...DBState.db.modelPresets];
        next[idx] = result.preset;
        DBState.db.modelPresets = next;
        notifySuccess(language.profileReplaced);
        return true;
    }

    async function selectProfile(entry: Entry) {
        const target = $modelProfileReplaceTarget;
        if (target) {
            if (await replacePresetProfile(target, entry)) {
                modelProfileReplaceTarget.set(null);
                close();
            }
        } else {
            createPresetFrom(entry);
        }
    }

    function safeFileName(id: string): string {
        return id.replace(/[^a-z0-9._-]/gi, '_');
    }

    // Export any profile (official or custom) as a self-contained, key-free
    // fragment so it can be edited and shared as a JSON file.
    async function exportProfile(profile: ModelProfile, baseProvider: BaseProviderDefinition | undefined) {
        if (!baseProvider) {
            alertError(language.profileExportNoBase);
            return;
        }
        const fragment = buildProfileFragment(profile, baseProvider, Date.now());
        await downloadFile(`${safeFileName(profile.id)}.profile.json`, JSON.stringify(fragment, null, 2));
    }

    async function importProfile() {
        const file = await selectSingleFile(['json']);
        if (!file) return;
        let parsed: unknown;
        try {
            parsed = JSON.parse(new TextDecoder().decode(file.data));
        } catch {
            alertError(language.profileImportParseError);
            return;
        }
        const res = validateFragment(parsed);
        if (!res.ok || !res.fragment) {
            alertError(`${language.profileImportInvalid}\n\n- ${res.errors.join('\n- ')}`);
            return;
        }
        const fragment = res.fragment;
        const cache = (DBState.db.modelProfileRegistryCache ??= createEmptyRegistryCache());
        const targetId = fragment.profile.id.startsWith(CUSTOM_ID_PREFIX)
            ? fragment.profile.id
            : `${CUSTOM_ID_PREFIX}${fragment.profile.id}`;
        const exists = cache.registries[CUSTOM_REGISTRY_ID]?.profiles?.[targetId] !== undefined;
        if (exists && !(await alertConfirm(language.profileOverwriteConfirm))) {
            return;
        }
        importFragment(cache, fragment, Date.now());
        activeTab = 'custom';
        notifySuccess(language.profileImported);
    }

    async function deleteCustom(profile: ModelProfile) {
        if (!(await alertConfirm(`${language.removeConfirm}${profile.displayName}`))) return;
        const cache = DBState.db.modelProfileRegistryCache;
        if (cache) removeCustomProfile(cache, profile.id);
        notifySuccess(language.presetDeleted);
    }
</script>

<div class="risu-modal-backdrop z-40 flex justify-center items-center">
    <div class="bg-darkbg p-4 break-any rounded-md flex flex-col max-w-3xl w-124 max-h-full overflow-hidden">
        <div class="flex items-center text-textcolor mb-4 shrink-0">
            <h2 class="mt-0 mb-0">{language.selectProfile}</h2>
            <div class="grow flex justify-end">
                <button class="text-textcolor2 risu-interactive-accent mr-2 cursor-pointer items-center" onclick={close}>
                    <XIcon size={20}/>
                </button>
            </div>
        </div>

        <div class="shrink-0 flex w-full rounded-md border border-selected mb-3">
            <button class="p-1.5 flex-1 text-sm" class:bg-selected={activeTab === 'official'} onclick={() => { activeTab = 'official' }}>{language.profileTabOfficial}</button>
            <button class="p-1.5 flex-1 text-sm" class:bg-selected={activeTab === 'custom'} onclick={() => { activeTab = 'custom' }}>{language.profileTabCustom}</button>
        </div>

        <div class="flex items-center gap-2 mb-3 shrink-0">
            <SearchIcon size={16} class="text-textcolor2 shrink-0" />
            <TextInput bind:value={query} placeholder={language.searchProfiles} fullwidth />
        </div>

        {#if activeTab === 'custom'}
            <button
                class="shrink-0 w-full flex items-center justify-center gap-2 mb-3 p-2 rounded-md border border-darkborderc bg-darkbutton risu-interactive-surface-solid text-sm"
                onclick={importProfile}
            >
                <UploadIcon size={16} class="shrink-0" />
                <span>{language.profileImport}</span>
            </button>
        {/if}

        {#snippet profileCard(entry: Entry)}
            {@const { profile, baseProvider } = entry}
            {@const localizedDesc = localizeDescription(profile)}
            <div class="flex items-start text-textcolor border border-darkborderc rounded-md p-3 risu-interactive-surface transition-colors">
                <button class="flex flex-col min-w-0 grow cursor-pointer text-left" onclick={() => selectProfile(entry)}>
                    <div class="flex items-center gap-2">
                        <span class="text-sm text-textcolor truncate">{localizeDisplayName(profile)}</span>
                        {#if profile.profileStatus !== 'current'}
                            <span
                                class="text-[10px] leading-none px-1.5 py-0.5 rounded shrink-0
                                {profile.profileStatus === 'deprecated' ? 'bg-red-500/15 text-draculared' : 'bg-amber-500/15 text-amber-500'}"
                            >
                                {profile.profileStatus === 'deprecated' ? language.profileStatusDeprecated : language.profileStatusOutdated}
                            </span>
                        {/if}
                        {#if baseProvider}
                            <span class="text-xs text-textcolor2 shrink-0">[{baseProvider.displayName}]</span>
                        {/if}
                    </div>
                    <span class="text-xs text-textcolor2 truncate">
                        {entry.transientPlugin ? pluginProfileDisplayId(profile.modelId) : profile.id}
                    </span>
                    {#if profile.updatedAt}
                        <span class="text-xs text-textcolor2">{language.profileUpdatedAtLabel}: {new Date(profile.updatedAt).toLocaleDateString()}</span>
                    {/if}
                    {#if localizedDesc}
                        <span class="text-xs text-textcolor2 mt-1 truncate">{localizedDesc}</span>
                    {/if}
                    {#if profile.statusReason}
                        <span class="text-xs text-textcolor2 mt-1 truncate">{profile.statusReason}</span>
                    {/if}
                </button>
                <div class="flex gap-2 shrink-0 ml-2">
                    <button class="text-textcolor2 risu-interactive-accent cursor-pointer" title={language.profileExport} onclick={() => exportProfile(profile, baseProvider)}>
                        <DownloadIcon size={18}/>
                    </button>
                    {#if activeTab === 'custom'}
                        <button class="text-textcolor2 risu-interactive-danger cursor-pointer" title={language.profileDelete} onclick={() => deleteCustom(profile)}>
                            <TrashIcon size={18}/>
                        </button>
                    {/if}
                </div>
            </div>
        {/snippet}

        <div class="flex flex-col gap-1 overflow-y-auto">
            {#if filtered.length === 0}
                <div class="text-textcolor2 text-sm text-center py-8">
                    {activeTab === 'custom' ? language.customProfileEmpty : language.noProfileMatch}
                </div>
            {:else}
                {#each groupedByProvider as group (group.id)}
                    <section class="flex flex-col gap-1 mt-2 first:mt-0">
                        <button
                            class="flex items-center gap-1.5 px-1 py-1 text-textcolor2 risu-interactive-foreground transition-colors cursor-pointer"
                            onclick={() => toggleProvider(group.id)}
                        >
                            {#if isProviderExpanded(group.id)}
                                <ChevronDownIcon size={16} class="shrink-0" />
                            {:else}
                                <ChevronRightIcon size={16} class="shrink-0" />
                            {/if}
                            <span class="text-sm font-semibold">{group.label}</span>
                            <span class="text-xs">({group.entries.length})</span>
                        </button>
                        {#if isProviderExpanded(group.id)}
                            {#each group.entries as entry (entry.profile.id)}
                                {@render profileCard(entry)}
                            {/each}
                        {/if}
                    </section>
                {/each}
            {/if}
        </div>
    </div>
</div>

<style>
    .break-any{
        word-break: normal;
        overflow-wrap: anywhere;
    }
</style>
