<script lang="ts">
    import type { SettingItem, SettingContext } from 'src/ts/setting/types';
    import { UNINITIALIZED, getLabel, getSettingValue, setSettingValue } from 'src/ts/setting/utils';
    import { untrack } from 'svelte';
    import TextInput from 'src/lib/UI/GUI/TextInput.svelte';
    import ShCombobox from 'src/lib/UI/GUI/ShCombobox.svelte';
    import Help from 'src/lib/Others/Help.svelte';
    import SettingRowLayout from './SettingRowLayout.svelte';

    interface Props {
        item: SettingItem;
        ctx: SettingContext;
    }

    let { item, ctx }: Props = $props();

    let localValue: any = $state(untrack(() => getSettingValue(item, ctx)));
    let suggestions = $derived(item.options?.suggestions ?? []);

    // Sync: DB → local (one-way read)
    $effect(() => {
        localValue = getSettingValue(item, ctx);
    });

    // Write-back: local → DB (guarded)
    $effect(() => {
        const val = localValue;
        if (val === UNINITIALIZED) return;
        untrack(() => {
            if (val !== getSettingValue(item, ctx)) {
                setSettingValue(item, val, ctx);
            }
        });
    });
</script>

{#if ctx.layout === 'row'}
    <SettingRowLayout {item}>
        {#snippet control()}
            {#if suggestions.length > 0 && !item.options?.hideText}
                <ShCombobox
                    containerClassName="w-48"
                    className="h-8 w-full text-sm"
                    size="sm"
                    options={suggestions}
                    bind:value={localValue}
                    placeholder={item.options?.placeholder}
                />
            {:else}
                <TextInput
                    className="h-8 w-48 text-sm"
                    size="sm"
                    bind:value={localValue}
                    placeholder={item.options?.placeholder}
                    hideText={item.options?.hideText}
                />
            {/if}
        {/snippet}
    </SettingRowLayout>
{:else}
    <span class="text-textcolor {item.classes ?? ''}">
        {getLabel(item)}
        {#if item.helpKey}<Help key={item.helpKey as any}/>{/if}
    </span>
    {#if suggestions.length > 0 && !item.options?.hideText}
        <ShCombobox
            className="mt-2"
            marginBottom={true}
            options={suggestions}
            bind:value={localValue}
            placeholder={item.options?.placeholder}
        />
    {:else}
        <TextInput
            className="mt-2"
            marginBottom={true}
            bind:value={localValue}
            placeholder={item.options?.placeholder}
            hideText={item.options?.hideText}
        />
    {/if}
{/if}
