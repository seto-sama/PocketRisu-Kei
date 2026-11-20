<script lang="ts">
    import type { SettingItem, SettingContext } from 'src/ts/setting/types';
    import { getLabel, getSettingValue, setSettingValue } from 'src/ts/setting/utils';
    import { untrack } from 'svelte';
    import ChoiceGroup from '../../UI/components/ChoiceGroup.svelte';
    import Help from 'src/lib/Others/Help.svelte';
    import { language } from 'src/lang';

    interface Props {
        item: SettingItem;
        ctx: SettingContext;
    }

    let { item, ctx }: Props = $props();

    let localValue: any = $derived(getSettingValue(item, ctx));

    function commitValue(val: any) {
        localValue = val;
        untrack(() => {
            if (val !== getSettingValue(item, ctx)) {
                setSettingValue(item, val, ctx);
            }
        });
    }

    // Transform options: filter by condition + resolve labelKey translations
    let processedOptions = $derived((item.options?.segmentOptions ?? [])
        .filter(opt => !opt.condition || opt.condition(ctx))
        .map(opt => ({
            value: opt.value,
            label: opt.labelKey ? ((language as any)[opt.labelKey] ?? opt.label ?? '') : (opt.label ?? '')
        })));

    // Reset value if current selection becomes hidden due to condition changes
    $effect(() => {
        const currentVal = untrack(() => localValue);
        if (processedOptions.length > 0 && currentVal !== undefined && !processedOptions.some(o => o.value === currentVal)) {
            commitValue(processedOptions[processedOptions.length - 1].value);
        }
    });
</script>

<span class="text-maintext {item.classes ?? ''}" data-setting-id={item.id}>
    {getLabel(item)}
    {#if item.helpKey}<Help key={item.helpKey as any}/>{/if}
</span>
<!-- ChoiceGroup values are strings, so numeric options are mapped back on change. -->
<ChoiceGroup
    variant="segment"
    size="md"
    className="mb-4"
    value={String(localValue)}
    options={processedOptions.map(opt => ({ ...opt, value: String(opt.value) }))}
    onValueChange={(v) => { commitValue(processedOptions.find(opt => String(opt.value) === v)?.value ?? v) }}
/>
