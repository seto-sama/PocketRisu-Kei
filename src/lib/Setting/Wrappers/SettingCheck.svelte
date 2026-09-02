<script lang="ts">
    import type { SettingItem, SettingContext } from 'src/ts/setting/types';
    import { UNINITIALIZED, getSettingValue, setSettingValue } from 'src/ts/setting/utils';
    import { untrack } from 'svelte';
    import Switch from '../../UI/components/Switch.svelte';
    import SettingItemRow from './SettingItemRow.svelte';

    interface Props {
        item: SettingItem;
        ctx: SettingContext;
    }

    let { item, ctx }: Props = $props();

    let localValue: any = $state(untrack(() => getSettingValue(item, ctx)));
    let disabled = $derived(typeof item.options?.disabled === 'function' ? item.options.disabled(ctx) : !!item.options?.disabled);

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
</script>

<SettingItemRow {item}>
    {#snippet control()}
        <Switch checked={!!localValue} {disabled} onCheckedChange={(v) => (localValue = v)} />
    {/snippet}
</SettingItemRow>
