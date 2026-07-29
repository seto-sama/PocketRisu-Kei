<script lang="ts">
    import { language } from "src/lang";
    import { PlusIcon, PencilIcon, TrashIcon } from "@lucide/svelte";
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
    import ShButton from "src/lib/UI/GUI/ShButton.svelte";
    import TextInput from "src/lib/UI/GUI/TextInput.svelte";
    import SecretInput from "src/lib/UI/GUI/SecretInput.svelte";
    import SelectInput from "src/lib/UI/GUI/SelectInput.svelte";
    import OptionInput from "src/lib/UI/GUI/OptionInput.svelte";
    import ShSortableList from "src/lib/UI/GUI/ShSortableList.svelte";

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
        DBState.db.modelProfileHiddenProviderIds,
        DBState.db.modelProfileProviderFilterInitialized === true,
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
    <p class="text-xs text-textcolor2">{language.help.apiKeyManagerDesc}</p>

    {#snippet apiKeyForm()}
        <div class="flex flex-col gap-3 border border-darkborderc rounded-md p-3">
            <div class="flex flex-col gap-1">
                <span class="text-sm text-textcolor">{language.apiKeyName}</span>
                <TextInput bind:value={fName} placeholder={language.apiKeyName} fullwidth />
            </div>
            <div class="flex flex-col gap-1">
                <span class="text-sm text-textcolor">{language.apiKeyProvider}</span>
                <SelectInput bind:value={fProvider}>
                    <OptionInput value="">{language.apiKeyProviderUnset}</OptionInput>
                    {#if fProvider && !providerOptions.some(o => o.id === fProvider)}
                        <OptionInput value={fProvider}>{providerLabel(fProvider)}</OptionInput>
                    {/if}
                    {#each providerOptions as opt (opt.id)}
                        <OptionInput value={opt.id}>{opt.name}</OptionInput>
                    {/each}
                </SelectInput>
            </div>
            <div class="flex flex-col gap-1">
                <span class="text-sm text-textcolor">{language.apiKeyValue}</span>
                <SecretInput bind:value={fKey} fullwidth />
            </div>
            <div class="flex justify-end gap-2">
                <ShButton variant="outline" size="sm" onclick={closeForm}>{language.cancel}</ShButton>
                <ShButton variant="primary" size="sm" onclick={save}>{language.apiKeyFormSave}</ShButton>
            </div>
        </div>
    {/snippet}

    {#if formOpen && editId === null}
        {@render apiKeyForm()}
    {:else}
        <ShButton variant="outline" size="default" className="w-full" onclick={openAdd}>
            <PlusIcon />
            <span class="ml-1">{language.apiKeyAdd}</span>
        </ShButton>
    {/if}

    {#if entries.length === 0}
        <div class="text-textcolor2 text-sm text-center py-6">{language.apiKeyPoolEmpty}</div>
    {:else}
        <ShSortableList
            className="flex flex-col gap-3"
            disabled={formOpen}
            onReorder={(orderedIds) => reorderApiKeys(orderedIds)}
        >
            {#each entries as entry, i (entry.id)}
                <div
                    data-sortable-key={entry.id}
                    class="flex items-center border border-darkborderc rounded-md p-3 gap-2 hover:bg-selected/30 transition-colors"
                    class:hidden={formOpen && editId === entry.id}
                    role="listitem"
                >
                    <div class="flex flex-col min-w-0 grow">
                        <span class="text-sm text-textcolor truncate">{entry.name}</span>
                        <span class="text-xs text-textcolor2 truncate">
                            {#if entry.provider}{providerLabel(entry.provider)} · {/if}••••{entry.key.slice(-4)}
                        </span>
                    </div>
                    <div class="no-sort flex gap-2 shrink-0">
                        <button class="text-textcolor2 hover:text-primary" title={language.edit} onclick={() => openEdit(entry.id)}>
                            <PencilIcon size={18} />
                        </button>
                        <button class="text-textcolor2 hover:text-red-400" title={language.remove} onclick={() => remove(entry.id, entry.name)}>
                            <TrashIcon size={18} />
                        </button>
                    </div>
                </div>
                {#if formOpen && editId === entry.id}
                    {@render apiKeyForm()}
                {/if}
            {/each}
        </ShSortableList>
    {/if}
</div>
