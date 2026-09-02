<script lang="ts">
    import type { SettingItem, SettingContext } from 'src/ts/setting/types';
    import { getLabel, getSettingValue, setSettingValue } from 'src/ts/setting/utils';
    import { untrack } from 'svelte';
    import NumberInput from 'src/lib/UI/GUI/NumberInput.svelte';
    import ShSwitch from 'src/lib/UI/GUI/ShSwitch.svelte';
    import Help from 'src/lib/Others/Help.svelte';
    import SettingItemRow from './SettingItemRow.svelte';

    interface Props {
        item: SettingItem;
        ctx: SettingContext;
    }

    let { item, ctx }: Props = $props();

    let localValue: any = $state(untrack(() => getSettingValue(item, ctx)));
    let disabled = $derived(typeof item.options?.disabled === 'function' ? item.options.disabled(ctx) : !!item.options?.disabled);
    let numberEnabled = $derived(typeof localValue === 'number' && localValue !== -1000);

    // Sync: DB → local (one-way read)
    $effect(() => {
        localValue = getSettingValue(item, ctx);
    });

    function commitValue(val: number | undefined) {
        const nextValue = val === undefined && item.options?.disableable ? -1000 : val;
        if (nextValue === undefined) return;
        localValue = nextValue;
        untrack(() => {
            if (nextValue !== getSettingValue(item, ctx)) {
                setSettingValue(item, nextValue, ctx);
            }
        });
        void item.options?.onCommit?.(nextValue, ctx);
    }

    function setNumberEnabled(on: boolean) {
        commitValue(on ? (item.options?.min ?? 0) : undefined);
    }
</script>

{#if ctx.layout === 'row' || ctx.layout === 'block'}
    <!-- A number field needs no full-width control, so the block layout is
         identical to the row layout: label + inline help stacked on the left,
         compact input vertically centered on the right (SettingItemRow). -->
    <SettingItemRow {item}>
        {#snippet control()}
            {#if !item.options?.disableable || numberEnabled}
                <div class="flex items-center gap-2">
                    <NumberInput
                        className={item.options?.inputClassName ?? 'w-24'}
                        size="sm"
                        padding={true}
                        min={item.options?.min}
                        max={item.options?.max}
                        allowEmpty={item.options?.disableable}
                        placeholder={item.options?.placeholder}
                        {disabled}
                        bind:value={localValue}
                        commitMode={item.options?.commitMode ?? 'blur'}
                        debounceMs={item.options?.debounceMs}
                        onCommit={commitValue}
                    />
                    {#if item.options?.suffix}<span class="text-textcolor2 text-xs shrink-0">{item.options.suffix}</span>{/if}
                </div>
            {:else}
                <ShSwitch checked={false} onCheckedChange={setNumberEnabled} />
            {/if}
        {/snippet}
    </SettingItemRow>
{:else}
    <span class="text-textcolor {item.classes ?? ''}" data-setting-id={item.id}>
        {getLabel(item)}
        {#if item.helpKey}<Help key={item.helpKey as any}/>{/if}
    </span>
    <NumberInput
        className="mt-2"
        marginBottom={true}
        min={item.options?.min}
        max={item.options?.max}
        allowEmpty={item.options?.disableable}
        placeholder={item.options?.placeholder}
        {disabled}
        bind:value={localValue}
        commitMode={item.options?.commitMode ?? 'blur'}
        debounceMs={item.options?.debounceMs}
        onCommit={commitValue}
    />
{/if}
