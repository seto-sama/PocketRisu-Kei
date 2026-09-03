<script lang="ts">
    import { CheckIcon, ChevronDownIcon } from '@lucide/svelte';
    import { Select } from 'bits-ui';
    import { isTouchDevice } from 'src/ts/stores.svelte';
    import { provideOverlayLayer } from 'src/ts/gui/overlayLayer.svelte';
    import OverlayLayerRoot from './overlay/OverlayLayerRoot.svelte';

    interface Props {
        value: string;
        className?: string;
        size?: 'sm' | 'md' | 'lg' | 'xl';
        children?: import('svelte').Snippet;
        onchange?: (event: Event & { currentTarget: EventTarget & HTMLSelectElement }) => unknown;
    }

    let {
        value = $bindable(),
        className = '',
        size = 'md',
        children,
        onchange,
    }: Props = $props();

    let selectEl = $state<HTMLSelectElement>();
    let open = $state(false);
    let options = $state<{ value: string; label: string }[]>([]);
    provideOverlayLayer(() => open);

    const sizeClasses = {
        sm: 'h-8 px-2.5 text-sm gap-1',
        md: 'h-10 px-2.5 text-base gap-1.5',
        lg: 'h-11 px-3 text-base gap-1.5',
        xl: 'h-12 px-3 text-lg gap-1.5',
    };

    const itemSizeClasses = {
        sm: 'px-2 py-1 pr-7 text-sm',
        md: 'pl-2 pr-8 py-1.5 text-base',
        lg: 'px-3 py-2 pr-9 text-base',
        xl: 'px-3 py-2 pr-9 text-lg',
    };

    const selectedLabel = $derived(
        options.find(option => option.value === value)?.label ?? '',
    );

    function extractOptions() {
        if (!selectEl) return;
        options = Array.from(selectEl.options).map(option => ({
            value: option.value,
            label: option.textContent?.trim() ?? option.value,
        }));
    }

    function selectValue(nextValue: string) {
        if (!selectEl || nextValue === value) return;
        selectEl.value = nextValue;
        selectEl.dispatchEvent(new Event('change', { bubbles: true }));
        value = nextValue;
    }

    function handleOpenChange(nextOpen: boolean) {
        if (nextOpen) extractOptions();
        open = nextOpen;
    }

    $effect(() => {
        void value;
        if (selectEl) extractOptions();
    });
</script>

{#if $isTouchDevice}
    <div class="relative rounded-md border border-darkborderc {className}">
        <div class="flex items-center justify-between rounded-md bg-transparent text-maintext pointer-events-none select-none {sizeClasses[size]}">
            <span class="flex flex-1 truncate text-left">{selectedLabel || ' '}</span>
            <ChevronDownIcon class="size-4 shrink-0 text-subtext" />
        </div>
        <select
            bind:this={selectEl}
            bind:value
            {onchange}
            class="absolute inset-0 size-full cursor-pointer opacity-0"
        >
            {@render children?.()}
        </select>
    </div>
{:else}
    <select bind:this={selectEl} bind:value {onchange} class="sr-only" tabindex={-1}>
        {@render children?.()}
    </select>

    <Select.Root
        type="single"
        {value}
        items={options}
        {open}
        onOpenChange={handleOpenChange}
        onValueChange={selectValue}
    >
        <Select.Trigger
            class="flex items-center justify-between rounded-md border border-darkborderc bg-transparent text-maintext outline-none transition-colors risu-interactive-surface {sizeClasses[size]} {className}"
            data-slot="select-trigger"
        >
            <span class="flex flex-1 truncate text-left">{selectedLabel || ' '}</span>
            <ChevronDownIcon class="size-4 shrink-0 text-subtext" />
        </Select.Trigger>
        {#if open}<Select.Portal>
            <OverlayLayerRoot interactive>
                <Select.Content
                    forceMount
                    sideOffset={4}
                    collisionPadding={8}
                    class="risu-layer-overlay z-[var(--risu-overlay-z)] min-w-[var(--bits-select-anchor-width)] max-h-[var(--bits-select-content-available-height)] overflow-hidden rounded-md border border-darkborderc bg-darkbg p-1 text-maintext shadow-md outline-none data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95"
                    data-slot="select-content"
                >
                    <Select.Viewport class="max-h-[var(--bits-select-content-available-height)] overflow-y-auto">
                        {#each options as option (option.value)}
                            <Select.Item
                                value={option.value}
                                label={option.label}
                                class="relative flex w-full cursor-pointer select-none items-center gap-2 whitespace-nowrap rounded-md text-left outline-none data-highlighted:bg-selected {itemSizeClasses[size]}"
                            >
                                {option.label}
                                {#if option.value === String(value)}
                                    <span class="pointer-events-none absolute right-2 flex size-4 items-center justify-center">
                                        <CheckIcon class="size-4 text-primary" />
                                    </span>
                                {/if}
                            </Select.Item>
                        {/each}
                    </Select.Viewport>
                </Select.Content>
            </OverlayLayerRoot>
        </Select.Portal>{/if}
    </Select.Root>
{/if}
