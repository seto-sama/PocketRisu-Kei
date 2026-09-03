<script lang="ts">
    import { ListFilterIcon, SearchIcon } from "@lucide/svelte";
    import { language } from "src/lang";
    import { DBState } from "src/ts/stores.svelte";
    import {
        getOfficialRegistry,
        getOfficialRegistryId,
        listFilterableProviderGroups,
        resolveProviderFilterHiddenIds,
    } from "src/ts/preset/registry";
    import Button from "../../../UI/components/Button.svelte";
    import Dialog from "../../../UI/components/Dialog.svelte";
    import Input from "../../../UI/components/Input.svelte";
    import Switch from "../../../UI/components/Switch.svelte";
    import SettingLayout from "src/lib/Setting/Wrappers/SettingLayout.svelte";

    let open = $state(false);
    let query = $state("");
    let draftHiddenProviderIds = $state<string[]>([]);

    const registry = $derived(getOfficialRegistry());
    const providers = $derived(listFilterableProviderGroups(registry, getOfficialRegistryId()));
    const hiddenProviderIds = $derived(resolveProviderFilterHiddenIds(
        providers.map(provider => provider.id),
        DBState.db.modelProfileVisibleProviderIds,
        DBState.db.modelProfileProviderFilterInitialized === true,
        DBState.db.modelProfileHiddenProviderIds,
    ));
    const draftHiddenProviderSet = $derived(new Set(draftHiddenProviderIds));
    const visibleProviderCount = $derived(
        providers.reduce((count, provider) => count + (hiddenProviderIds.has(provider.id) ? 0 : 1), 0),
    );
    const filteredProviders = $derived.by(() => {
        const normalized = query.trim().toLowerCase();
        if (!normalized) return providers;
        return providers.filter(provider =>
            provider.label.toLowerCase().includes(normalized)
            || provider.id.toLowerCase().includes(normalized)
        );
    });

    function writeHiddenProviderIds(next: Set<string>) {
        DBState.db.modelProfileProviderFilterInitialized = true;
        const currentProviderIds = new Set(providers.map(provider => provider.id));
        const temporarilyMissingVisibleIds = (DBState.db.modelProfileVisibleProviderIds ?? [])
            .filter(providerId => !currentProviderIds.has(providerId));
        DBState.db.modelProfileVisibleProviderIds = [...new Set([
            ...temporarilyMissingVisibleIds,
            ...providers.filter(provider => !next.has(provider.id)).map(provider => provider.id),
        ])].sort();
        delete DBState.db.modelProfileHiddenProviderIds;
    }

    function setProviderVisible(providerId: string, visible: boolean) {
        const next = new Set(draftHiddenProviderSet);
        if (visible) next.delete(providerId);
        else next.add(providerId);
        draftHiddenProviderIds = [...next].sort();
    }

    function setAllProvidersVisible(visible: boolean) {
        if (visible) {
            draftHiddenProviderIds = [];
            return;
        }
        const next = new Set(draftHiddenProviderSet);
        for (const provider of providers) next.add(provider.id);
        draftHiddenProviderIds = [...next].sort();
    }

    function openDialog() {
        query = "";
        draftHiddenProviderIds = [...hiddenProviderIds].sort();
        open = true;
    }

    function saveDialog() {
        writeHiddenProviderIds(new Set(draftHiddenProviderSet));
        open = false;
    }
</script>

<div class="flex items-center justify-between gap-3 py-3 border-t border-darkborderc">
    <div class="flex flex-col min-w-0">
        <span class="text-sm text-maintext">{language.modelProviderFilter}</span>
        <p class="text-xs text-subtext mt-0.5">
            {#if providers.length > 0}
                {language.modelProviderFilterSummary(visibleProviderCount, providers.length)}
            {:else}
                {language.modelProviderFilterEmpty}
            {/if}
        </p>
    </div>
    <Button variant="outline" size="sm" onclick={openDialog} className="shrink-0">
        <ListFilterIcon />
        <span class="ml-1">{language.modelProviderFilterConfigure}</span>
    </Button>
</div>

<Dialog bind:open size="lg" closeOnEscape={true}>
    {#snippet title()}{language.modelProviderFilterDialogTitle}{/snippet}
    {#snippet description()}{language.modelProviderFilterDialogDescription}{/snippet}

    {#if providers.length === 0}
        <p class="text-sm text-subtext py-6 text-center">{language.modelProviderFilterEmpty}</p>
    {:else}
        <div class="flex flex-col gap-3">
            <div class="flex items-center gap-2">
                <div class="relative flex-1 min-w-0">
                    <SearchIcon
                        size={16}
                        class="absolute left-2.5 top-1/2 -translate-y-1/2 text-subtext pointer-events-none"
                    />
                    <Input
                        bind:value={query}
                        placeholder={language.modelProviderFilterSearch}
                        aria-label={language.modelProviderFilterSearch}
                        className="pl-8"
                    />
                </div>
                <Button variant="outline" onclick={() => setAllProvidersVisible(true)}>
                    {language.modelProviderFilterShowAll}
                </Button>
                <Button variant="outline" onclick={() => setAllProvidersVisible(false)}>
                    {language.modelProviderFilterHideAll}
                </Button>
            </div>

            <SettingLayout variant="list">
                {#if filteredProviders.length === 0}
                    <p class="text-sm text-subtext py-6 text-center">
                        {language.modelProviderFilterNoMatch}
                    </p>
                {:else}
                    {#each filteredProviders as provider (provider.id)}
                        <SettingLayout variant="item" className="py-2.5">
                            <div class="flex flex-1 flex-col min-w-0">
                                <span class="text-sm text-maintext truncate">{provider.label}</span>
                                <span class="text-xs text-subtext truncate">
                                    {provider.id} · {language.modelProviderFilterProfileCount(provider.profileCount)}
                                </span>
                            </div>
                            {#snippet control()}
                                <Switch
                                    checked={!draftHiddenProviderSet.has(provider.id)}
                                    ariaLabel={`${provider.label}: ${language.modelProviderFilter}`}
                                    onCheckedChange={(checked) => setProviderVisible(provider.id, checked)}
                                />
                            {/snippet}
                        </SettingLayout>
                    {/each}
                {/if}
            </SettingLayout>
        </div>
    {/if}

    {#snippet footer()}
        <Button variant="primary" size="sm" onclick={saveDialog}>
            {language.modelProviderFilterSave}
        </Button>
    {/snippet}
</Dialog>
