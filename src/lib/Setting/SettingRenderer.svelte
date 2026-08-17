<script lang="ts">
    import type { SettingItem, SettingContext } from 'src/ts/setting/types';
    import { DBState } from 'src/ts/stores.svelte';
    import { settingRegistry } from 'src/ts/setting/settingRegistry';
    import { checkCondition } from 'src/ts/setting/utils';

    interface Props {
        items: SettingItem[];
        /** Optional object used as the root for bindKey/bindPath. */
        target?: object;
        /** 'row' renders row-capable wrappers (select/text/slider) with the label
         * + inline help on the left and the control right-aligned. 'block' renders
         * the ModelPreset-editor field grammar (label row + full-width control).
         * Default 'stacked'. */
        layout?: 'stacked' | 'row' | 'block';
    }

    let { items, target, layout = 'stacked' }: Props = $props();

    // Build context for condition checks
    let ctx: SettingContext = $derived({
        db: DBState.db,
        target,
        layout,
    });
</script>

{#snippet itemList()}
    {#each items as item (item.id)}
        {#if checkCondition(item, ctx)}
            {@const Component = settingRegistry[item.type]}
            {#if Component}
                <Component {item} {ctx} />
            {:else}
                <div class="text-draculared text-xs mt-2">Unknown setting type: {item.type}</div>
            {/if}
        {/if}
    {/each}
{/snippet}

{#if layout === 'row'}
    <!-- Row wrappers carry their own top border; custom items (warnings,
         editors) don't, so they attach to the option above with no divider.
         Drop the very first row's leading border. -->
    <div class="[&>*:first-child]:border-t-0">
        {@render itemList()}
    </div>
{:else if layout === 'block'}
    <!-- Block fields share the row layout's divider rhythm (border-t per field,
         first divider dropped) — see AccessibilitySettings for the reference. -->
    <div class="[&>*:first-child]:border-t-0">
        {@render itemList()}
    </div>
{:else}
    {@render itemList()}
{/if}
