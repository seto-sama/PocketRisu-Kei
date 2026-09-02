<script lang="ts">
    import type { SettingItem, SettingContext } from 'src/ts/setting/types';
    import { UNINITIALIZED, getLabel, getSettingValue, setSettingValue } from 'src/ts/setting/utils';
    import { untrack } from 'svelte';
    import Select from '../../UI/components/Select.svelte';
    import SelectOption from '../../UI/components/SelectOption.svelte';
    import Help from 'src/lib/Others/Help.svelte';
    import SettingItemRow from './SettingItemRow.svelte';
    import { language } from 'src/lang';

    interface Props {
        item: SettingItem;
        ctx: SettingContext;
    }

    let { item, ctx }: Props = $props();

    let localValue: any = $state(untrack(() => getSettingValue(item, ctx)));

    // Sync: DB → local (one-way read)
    $effect(() => {
        localValue = getSettingValue(item, ctx);
    });

    // Write-back: local → DB (guarded — only fires on actual user changes)
    $effect(() => {
        const val = localValue;
        if (val === UNINITIALIZED) return;
        untrack(() => {
            if (val !== getSettingValue(item, ctx)) {
                setSettingValue(item, val, ctx);
            }
        });
    });

    // Process options to support labelKey translation and conditional rendering
    let processedOptions = $derived((item.options?.selectOptions ?? []).filter(opt => !opt.condition || opt.condition(ctx)));

    // Reset value if current selection becomes hidden.
    // Falls back to the first option (treated as the default by convention — see SelectOption).
    $effect(() => {
        const currentValue = untrack(() => localValue);
        if (processedOptions.length > 0 && currentValue !== undefined && !processedOptions.some(o => o.value === currentValue)) {
            localValue = processedOptions[0].value;
        }
    });
</script>

{#if ctx.layout === 'row'}
    <SettingItemRow {item}>
        {#snippet control()}
            <Select className="w-48" size="sm" bind:value={localValue}>
                {#each processedOptions as opt}
                    <SelectOption value={opt.value}>
                        {opt.labelKey ? (language as any)[opt.labelKey] : opt.label}
                    </SelectOption>
                {/each}
            </Select>
        {/snippet}
    </SettingItemRow>
{:else}
    <span class="text-maintext {item.classes ?? 'mt-4'}" data-setting-id={item.id}>
        {getLabel(item)}
        {#if item.helpKey}<Help key={item.helpKey as any}/>{/if}
    </span>
    <Select className="mt-2 mb-4" bind:value={localValue}>
        {#each processedOptions as opt}
            <SelectOption value={opt.value}>
                {opt.labelKey ? (language as any)[opt.labelKey] : opt.label}
            </SelectOption>
        {/each}
    </Select>
{/if}
