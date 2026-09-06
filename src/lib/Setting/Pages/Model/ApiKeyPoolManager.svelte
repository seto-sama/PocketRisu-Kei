<script lang="ts">
    import EmptyState from "src/lib/UI/components/EmptyState.svelte";
    import { language } from "src/lang";
    import { PlusIcon, SquarePenIcon, TrashIcon } from "@lucide/svelte";
    import { DBState } from "src/ts/stores.svelte";
    import {
        addApiKey,
        listApiKeyProviderOptions,
        updateApiKey,
        removeApiKey,
        reorderApiKeys,
        sortApiKeys,
        normalizeApiKeyProvider,
    } from "src/ts/preset/apiKeyPool";
    import {
        getOfficialRegistry,
        getOfficialRegistryId,
        listFilterableProviderGroups,
        resolveProviderFilterHiddenIds,
    } from "src/ts/preset/registry";
    import { alertConfirm } from "src/ts/alert";
    import Button from "../../../UI/components/Button.svelte";
    import Input from "../../../UI/components/Input.svelte";
    import SecretInput from "../../../UI/components/SecretInput.svelte";
    import Select from "../../../UI/components/Select.svelte";
    import SelectOption from "../../../UI/components/SelectOption.svelte";
    import SortableList from "../../../UI/components/SortableList.svelte";

    // Read straight off the reactive pool so the list reflects add/edit/delete.
    const entries = $derived(
        sortApiKeys(Object.values(DBState.db.apiKeyPool ?? {}))
    );

    const baseProviders = $derived.by(() => {
        const reg = getOfficialRegistry();
        return reg.registries?.[getOfficialRegistryId()]?.baseProviders ?? {};
    });
    const allProviderOptions = $derived(listApiKeyProviderOptions(baseProviders));
    const providerGroups = $derived(
        listFilterableProviderGroups(getOfficialRegistry(), getOfficialRegistryId())
    );
    const hiddenProviderIds = $derived(resolveProviderFilterHiddenIds(
        providerGroups.map(provider => provider.id),
        DBState.db.modelProfileVisibleProviderIds,
        DBState.db.modelProfileProviderFilterInitialized === true,
        DBState.db.modelProfileHiddenProviderIds,
    ));
    const providerOptions = $derived(
        listApiKeyProviderOptions(
            baseProviders,
            hiddenProviderIds,
        )
    );

    function providerLabel(id: string | undefined): string {
        if (!id) return '';
        const normalized = normalizeApiKeyProvider(id) ?? id;
        return allProviderOptions.find((p) => p.id === normalized)?.name ?? normalized;
    }

    // Single form doubles as add (editId null) and edit (editId set).
    let formOpen = $state(false);
    let editId = $state<string | null>(null);
    let fName = $state('');
    let fProvider = $state('');
    let fKey = $state('');

    function openAdd() {
        editId = null;
        fName = '';
        fProvider = '';
        fKey = '';
        formOpen = true;
    }

    function openEdit(id: string) {
        const e = DBState.db.apiKeyPool?.[id];
        if (!e) return;
        editId = id;
        fName = e.name;
        fProvider = normalizeApiKeyProvider(e.provider) ?? e.provider ?? '';
        fKey = e.key;
        formOpen = true;
    }

    function save() {
        if (!fName.trim() || !fKey.trim()) return;
        const provider = fProvider || undefined;
        if (editId) {
            updateApiKey(editId, { name: fName.trim(), key: fKey, provider });
        } else {
            addApiKey({ name: fName.trim(), key: fKey, provider });
        }
        formOpen = false;
    }

    function closeForm() {
        formOpen = false;
        editId = null;
    }

    async function remove(id: string, name: string) {
        const ok = await alertConfirm(`${language.removeConfirm}${name}`);
        if (!ok) return;
        removeApiKey(id);
    }

</script>

<div class="flex flex-col gap-3">
    {#snippet apiKeyForm()}
        <div class="flex flex-col gap-3 border border-darkborderc rounded-md p-3">
            <div class="flex flex-col gap-1">
                <span class="text-sm text-maintext">{language.apiKeyName}</span>
                <Input bind:value={fName} placeholder={language.apiKeyName} fullwidth />
            </div>
            <div class="flex flex-col gap-1">
                <span class="text-sm text-maintext">{language.apiKeyProvider}</span>
                <Select bind:value={fProvider}>
                    <SelectOption value="">{language.apiKeyProviderUnset}</SelectOption>
                    {#if fProvider && !providerOptions.some(o => o.id === fProvider)}
                        <SelectOption value={fProvider}>{providerLabel(fProvider)}</SelectOption>
                    {/if}
                    {#each providerOptions as opt (opt.id)}
                        <SelectOption value={opt.id}>{opt.name}</SelectOption>
                    {/each}
                </Select>
            </div>
            <div class="flex flex-col gap-1">
                <span class="text-sm text-maintext">{language.apiKeyValue}</span>
                <SecretInput bind:value={fKey} fullwidth />
            </div>
            <div class="flex justify-end gap-2">
                <Button variant="outline" size="sm" onclick={closeForm}>{language.cancel}</Button>
                <Button variant="primary" size="sm" onclick={save}>{language.apiKeyFormSave}</Button>
            </div>
        </div>
    {/snippet}

    {#if formOpen && editId === null}
        {@render apiKeyForm()}
    {:else}
        <Button variant="outline" size="default" className="w-full" onclick={openAdd}>
            <PlusIcon />
            <span class="ml-1">{language.apiKeyAdd}</span>
        </Button>
    {/if}

    {#if entries.length === 0}
        <EmptyState title={language.apiKeyPoolEmpty} description="" layout="section" density="compact" />
    {:else}
        <SortableList
            className="flex flex-col gap-3"
            disabled={formOpen}
            onReorder={(orderedIds) => reorderApiKeys(orderedIds)}
        >
            {#each entries as entry, i (entry.id)}
                <div
                    data-sortable-key={entry.id}
                    class="flex items-center border border-darkborderc rounded-md p-3 gap-2 risu-interactive-surface transition-colors"
                    class:hidden={formOpen && editId === entry.id}
                    role="listitem"
                >
                    <div class="flex flex-col min-w-0 grow">
                        <span class="text-sm text-maintext truncate">{entry.name}</span>
                        <span class="text-xs text-subtext truncate">
                            {#if entry.provider}{providerLabel(entry.provider)} · {/if}••••{entry.key.slice(-4)}
                        </span>
                    </div>
                    <div class="no-sort flex gap-2 shrink-0">
                        <button class="text-subtext risu-interactive-accent" title={language.edit} onclick={() => openEdit(entry.id)}>
                            <SquarePenIcon size={18} />
                        </button>
                        <button class="text-subtext risu-interactive-danger" title={language.remove} onclick={() => remove(entry.id, entry.name)}>
                            <TrashIcon size={18} />
                        </button>
                    </div>
                </div>
                {#if formOpen && editId === entry.id}
                    {@render apiKeyForm()}
                {/if}
            {/each}
        </SortableList>
    {/if}
</div>
