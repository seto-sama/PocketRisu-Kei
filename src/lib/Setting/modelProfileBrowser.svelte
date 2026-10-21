<script lang="ts">
    import EmptyState from "src/lib/UI/components/EmptyState.svelte";
    import { FolderIcon, FolderOpenIcon, SearchIcon } from "@lucide/svelte";
    import Dialog from "../UI/components/Dialog.svelte";
    import DisclosureList from "../UI/components/DisclosureList.svelte";
    import Button from "../UI/components/Button.svelte";
    import SettingLayout from "./Wrappers/SettingLayout.svelte";
    import { language } from "src/lang";
    import { DBState, modelProfileReplaceTarget, openModelPresetEditId } from "src/ts/stores.svelte";
    import { alertConfirm, alertError, notifySuccess } from "src/ts/alert";
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
    import {
        createModelPresetFromProfile,
        replaceModelPresetProfile,
    } from "src/ts/preset/profileUpdate";
    import { localizeDisplayName, localizeDescription } from "src/ts/preset/registry/i18n";
    import { getDefaultApiKeyRef } from "src/ts/preset/apiKeyPool";
    import { appendPresetItem } from "src/ts/preset/collection";
    import { createEntityId } from "src/ts/id";
    import type { BaseProviderDefinition, ModelProfile, RegistryCache, RegistryProfileStatus } from "src/ts/preset/types";
    import { customV3ProviderMetaStore } from "src/ts/plugins/apiV3/v3.svelte";
    import {
        buildPluginRegistry,
        listPluginModels,
        PLUGIN_REGISTRY_ID,
        pluginProfileDisplayId,
        pluginPresetAbilityDefaults,
    } from "src/ts/preset/pluginModels";
    import Input from "../UI/components/Input.svelte";
    import Badge from "../UI/components/Badge.svelte";
    import { onMount } from "svelte";

    let { open = $bindable(true) }: { open?: boolean } = $props();

    function close() {
        open = false
    }

    // Developer profiles exist synchronously; the models.dev catalog is
    // hydrated from its separate cache/network at runtime. Plugins merge below.
    const officialRegistry = $derived(getOfficialRegistry());

    onMount(() => {
        void syncRemoteRegistry();
    });

    let query = $state('');

    type Entry = {
        profile: ModelProfile;
        baseProvider: BaseProviderDefinition | undefined;
        registry: RegistryCache;
        registryId: string;
        transientPlugin: boolean;
    };

    const profileStatusOrder: RegistryProfileStatus[] = ['current', 'outdated', 'deprecated'];

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
        return out;
    }

    // API 3.0 registrations become self-contained preset snapshots.
    const pluginRegistry = $derived(buildPluginRegistry(
        listPluginModels(customV3ProviderMetaStore),
        language.pluginModelProfileDescription,
    ));

    // Provider filters apply to the catalog; built-in special profiles and
    // plugin models retain their existing visibility rules.
    const entries = $derived.by(() => {
        const registryId = getOfficialRegistryId();
        const all = buildEntries(officialRegistry, registryId);
        const level = DBState.db.modelProfileVisibilityLevel;
        const providerGroups = listFilterableProviderGroups(officialRegistry, registryId);
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

    // Related official APIs can share one vendor group while each model row
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
            id: createEntityId(),
            apiKeyRef: getDefaultApiKeyRef(profile.providerBaseId),
            abilityDefaults: entry.transientPlugin
                ? pluginPresetAbilityDefaults(profile.modelId, customV3ProviderMetaStore)
                : undefined,
        });
        if (!preset) {
            alertError(language.profileDataIncomplete);
            return;
        }
        DBState.db.modelPresets = appendPresetItem(DBState.db.modelPresets, preset).items;
        notifySuccess(language.modelPresetCreated);
        openModelPresetEditId.set(preset.id);
        close();
    }

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
</script>

<Dialog
    bind:open
    size="lg"
    contentClass="overflow-hidden"
    bodyClass="flex min-h-0 flex-col gap-4"
>
    {#snippet title()}{language.selectProfile}{/snippet}

    <SettingLayout variant="search" className="shrink-0">
        <div class="relative flex min-w-0 items-center">
            <SearchIcon
                size={16}
                class="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-subtext"
            />
            <Input
                bind:value={query}
                placeholder={language.searchProfiles}
                aria-label={language.searchProfiles}
                className="pl-8"
            />
        </div>
    </SettingLayout>

    <div class="min-h-0 overflow-y-auto overscroll-contain">
        {#if filtered.length === 0}
            <EmptyState layout="section" />
        {:else}
            <DisclosureList appearance="folder" className="gap-2">
                {#each groupedByProvider as group (group.id)}
                    {@const expanded = isProviderExpanded(group.id)}
                    {@const FolderGlyph = expanded ? FolderOpenIcon : FolderIcon}
                    <DisclosureList
                        variant="item"
                        appearance="folder"
                        open={expanded}
                        onToggle={() => toggleProvider(group.id)}
                        headerClass="min-h-9 text-maintext"
                        bodyClass="risu-tree-list risu-tree-list-centered gap-2 [--risu-tree-gap:0.5rem] [--risu-tree-item-border:1px]"
                        bodyPadded={false}
                    >
                        {#snippet header()}
                            <FolderGlyph size={20} class="risu-folder-icon mr-2 shrink-0" />
                            <span class="grow truncate text-sm font-medium">{group.label}</span>
                            <span class="ml-2 text-xs text-subtext">{group.entries.length}</span>
                        {/snippet}
                        {#each group.entries as entry (entry.profile.id)}
                            {@const { profile, baseProvider } = entry}
                            {@const localizedDesc = localizeDescription(profile)}
                            <Button
                                variant="outline"
                                data-tree-item
                                className="h-auto min-h-12 w-full min-w-0 justify-start bg-darkbg p-2 text-left font-normal"
                                onclick={() => selectProfile(entry)}
                            >
                                <span class="flex min-w-0 flex-1 flex-col gap-0.5">
                                    <span class="flex min-w-0 items-center gap-2">
                                        <span class="truncate text-sm font-medium">{localizeDisplayName(profile)}</span>
                                        {#if profile.profileStatus !== 'current'}
                                            <Badge
                                                variant={profile.profileStatus === 'deprecated' ? 'destructive' : 'attention'}
                                                size="xs"
                                            >
                                                {profile.profileStatus === 'deprecated' ? language.profileStatusDeprecated : language.profileStatusOutdated}
                                            </Badge>
                                        {/if}
                                    </span>
                                    <span class="truncate text-xs text-subtext">
                                        {entry.transientPlugin ? pluginProfileDisplayId(profile.modelId) : profile.id}
                                        {#if baseProvider} · {baseProvider.displayName}{/if}
                                    </span>
                                    {#if localizedDesc}
                                        <span class="truncate text-xs text-subtext">{localizedDesc}</span>
                                    {/if}
                                    {#if profile.statusReason}
                                        <span class="truncate text-xs text-subtext">{profile.statusReason}</span>
                                    {/if}
                                </span>
                            </Button>
                        {/each}
                    </DisclosureList>
                {/each}
            </DisclosureList>
        {/if}
    </div>
</Dialog>
