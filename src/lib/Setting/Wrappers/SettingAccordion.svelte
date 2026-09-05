<script lang="ts">
    import type { SettingItem, SettingContext } from 'src/ts/setting/types';
    import { getLabel } from 'src/ts/setting/utils';
    import Accordion from '../../UI/components/Accordion.svelte';
    import SettingRenderer from '../SettingRenderer.svelte'; // Recursive import

    interface Props {
        item: SettingItem;
        ctx: SettingContext;
    }

    let { item, ctx }: Props = $props();
</script>

<Accordion class="mt-2" name={getLabel(item)}>
    {#if item.options?.children}
        <SettingRenderer items={item.options.children} target={ctx.target} />
    {/if}
</Accordion>
