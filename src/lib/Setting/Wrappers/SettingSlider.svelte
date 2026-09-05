<script lang="ts">
    import type { SettingItem, SettingContext } from 'src/ts/setting/types';
    import { UNINITIALIZED, getLabel, getSettingValue, setSettingValue } from 'src/ts/setting/utils';
    import { untrack } from 'svelte';
    import { language } from 'src/lang';
    import Slider from '../../UI/components/Slider.svelte';
    import Switch from '../../UI/components/Switch.svelte';
    import Help from 'src/lib/Others/Help.svelte';
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

    // Read-only display formatter for the Slider row layout: only for sliders
    // whose value maps to a word/unit label (customText). Numeric sliders —
    // including fixed/decimal ones like line height — keep Slider's editable
    // input so the user can type a precise value.
    let rowFormat = $derived.by(() => {
        const ct = item.options?.customText;
        if (ct === undefined) return undefined;
        return typeof ct === 'function' ? ct : () => ct as string;
    });

    // ── 'block' layout (ModelPreset-editor field grammar) ──────────────────
    // Label row + inline help text + FULL-WIDTH Slider, with the row layout's
    // divider rhythm (border-t, dropped on the first field by SettingRenderer).
    // Stored slider values may use raw units (e.g. temperature
    // 0–200 hundredths) and only scales at display time via `multiple`; Slider
    // has no such concept, so the row/block branches convert to real units at the
    // binding boundary (track/input show 0.00–2.00, storage stays 0–200).
    // The -1000 "slider disabled" sentinel is surfaced as a header Switch
    // (the slot the ModelPreset editor uses for its Reset affordance); turning
    // it on restores the field default (falling back to `min` when no default
    // is declared).
    let blockHelpText = $derived(
        item.helpKey ? (language.help as any)[item.helpKey] : undefined
    );

    function roundReal(v: number): number {
        return Math.round(v * 1e6) / 1e6;
    }

    let sliderMult = $derived(item.options?.multiple ?? 1);
    let sliderMin = $derived(roundReal((item.options?.min ?? 0) * sliderMult));
    let sliderMax = $derived(roundReal((item.options?.max ?? 100) * sliderMult));
    let sliderStep = $derived(roundReal((item.options?.step ?? 1) * sliderMult));
    let rowSliderMin = $derived(
        item.options?.disableable ? roundReal(sliderMin - sliderStep) : sliderMin
    );
    let sliderEnabled = $derived(typeof localValue === 'number' && localValue !== -1000);

    function readSliderValue(): number {
        if (!sliderEnabled) return sliderMin;
        return roundReal(localValue * sliderMult);
    }

    function writeSliderValue(v: number) {
        localValue = roundReal(v / sliderMult);
    }

    function writeRowSliderValue(v: number) {
        if (item.options?.disableable && v < sliderMin) {
            localValue = -1000;
            return;
        }
        writeSliderValue(v);
    }

    function setSliderEnabled(on: boolean) {
        const defaultValue = item.options?.defaultValue;
        const enabledValue = typeof defaultValue === 'number' && Number.isFinite(defaultValue)
            ? defaultValue
            : (item.options?.min ?? 0);
        localValue = on ? enabledValue : -1000;
    }
</script>

{#if ctx.layout === 'row'}
    <SettingItemRow {item}>
        {#snippet control()}
            {#if !item.options?.disableable || sliderEnabled}
                <div class="w-48">
                    <Slider
                        min={rowSliderMin}
                        max={sliderMax}
                        step={sliderStep}
                        fixed={item.options?.fixed}
                        {disabled}
                        format={rowFormat}
                        inputWidth="w-16"
                        bind:value={readSliderValue, writeRowSliderValue}
                    />
                </div>
            {:else}
                <Switch checked={false} onCheckedChange={setSliderEnabled} />
            {/if}
        {/snippet}
    </SettingItemRow>
{:else if ctx.layout === 'block'}
    <!-- SettingRow grammar (label + inline help stacked left, affordance
         vertically centered right), plus a full-width slider third line. Markup
         is replicated rather than nesting SettingRow because the divider
         (border-t/py-3) must wrap the slider line too. -->
    <div class="py-3 border-t border-darkborderc">
        <div class="flex items-center justify-between gap-3">
            <div class="flex flex-col min-w-0">
                <span class="text-sm text-maintext {item.classes ?? ''}">{getLabel(item)}</span>
                {#if blockHelpText}<p class="text-xs text-subtext mt-0.5">{blockHelpText}</p>{/if}
            </div>
            {#if item.options?.disableable}
                <div class="flex shrink-0 items-center">
                    <Switch checked={sliderEnabled} onCheckedChange={setSliderEnabled} />
                </div>
            {/if}
        </div>
        {#if !item.options?.disableable || sliderEnabled}
            <Slider
                className="mt-2"
                min={sliderMin}
                max={sliderMax}
                step={sliderStep}
                {disabled}
                bind:value={readSliderValue, writeSliderValue}
            />
        {/if}
    </div>
{:else}
    <span class="text-maintext {item.classes ?? ''}" data-setting-id={item.id}>
        {getLabel(item)}
        {#if item.helpKey}<Help key={item.helpKey as any}/>{/if}
    </span>
    {#if !item.options?.disableable || sliderEnabled}
    <Slider
        className="mt-2 mb-4"
        min={sliderMin}
        max={sliderMax}
        step={sliderStep}
        fixed={item.options?.fixed}
        {disabled}
        format={rowFormat}
        bind:value={readSliderValue, writeSliderValue}
    />
    {:else}
        <div class="mt-2 mb-4"><Switch checked={false} onCheckedChange={setSliderEnabled} /></div>
    {/if}
{/if}
