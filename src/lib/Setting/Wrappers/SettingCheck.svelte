<script lang="ts">
    import type { SettingItem, SettingContext } from 'src/ts/setting/types';
    import { getSettingValue, setSettingValue } from 'src/ts/setting/utils';
    import Switch from '../../UI/components/Switch.svelte';
    import SettingItemRow from './SettingItemRow.svelte';

    interface Props {
        item: SettingItem;
        ctx: SettingContext;
    }

    let { item, ctx }: Props = $props();

    let disabled = $derived(typeof item.options?.disabled === 'function' ? item.options.disabled(ctx) : !!item.options?.disabled);
</script>

<SettingItemRow {item}>
    {#snippet control()}
        <Switch
            checked={!!getSettingValue(item, ctx)}
            reverse={item.options?.reverse}
            {disabled}
            onCheckedChange={(value) => setSettingValue(item, value, ctx)}
        />
    {/snippet}
</SettingItemRow>
