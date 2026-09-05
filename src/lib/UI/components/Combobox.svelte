<script lang="ts">
    import { Combobox } from 'bits-ui';
    import { cn } from 'src/lib/utils';
    import { provideOverlayLayer } from 'src/ts/gui/overlayLayer.svelte';
    import OverlayLayerRoot from './overlay/OverlayLayerRoot.svelte';

    interface Props {
        value: string;
        options: readonly string[];
        placeholder?: string;
        size?: 'sm' | 'md' | 'lg' | 'xl';
        className?: string;
        containerClassName?: string;
        marginBottom?: boolean;
        disabled?: boolean;
        oncommit?: (value: string) => void;
    }

    let {
        value = $bindable(),
        options,
        placeholder = '',
        size = 'md',
        className = '',
        containerClassName = 'w-full',
        marginBottom = false,
        disabled = false,
        oncommit = () => {},
    }: Props = $props();

    let open = $state(false);
    provideOverlayLayer(() => open);

    const uniqueOptions = $derived([...new Set(options.filter(Boolean))]);
    const filteredOptions = $derived.by(() => {
        const query = String(value ?? '').trim().toLowerCase();
        if (!query) return uniqueOptions;
        return uniqueOptions.filter(option => option.toLowerCase().includes(query));
    });
    const items = $derived(uniqueOptions.map(option => ({ value: option, label: option })));

    const sizeClasses = {
        sm: 'h-8 min-h-8 px-2 text-sm',
        md: 'h-10 min-h-10 px-2.5 text-base',
        lg: 'h-11 min-h-11 px-3 text-base',
        xl: 'h-12 min-h-12 px-3 text-lg',
    };

    function handleInput(event: Event) {
        value = (event.currentTarget as HTMLInputElement).value;
        open = true;
    }

    function handleValueChange(nextValue: string) {
        value = nextValue;
        oncommit(nextValue);
        open = false;
    }

</script>

<div class={cn('relative', containerClassName, marginBottom && 'mb-4')} onfocusin={() => (open = true)}>
    <Combobox.Root
        type="single"
        value={uniqueOptions.includes(value) ? value : ''}
        inputValue={value}
        {items}
        {disabled}
        bind:open
        onValueChange={handleValueChange}
    >
        <Combobox.Input
            {placeholder}
            autocomplete="off"
            onfocus={() => (open = true)}
            oninput={handleInput}
            onblur={() => oncommit(value)}
            class={cn(
                'risu-field-border w-full min-w-0 rounded-md bg-transparent text-maintext disabled:cursor-not-allowed disabled:opacity-50',
                sizeClasses[size],
                className,
            )}
            data-slot="combobox-input"
        />

        {#if open && filteredOptions.length > 0}
            <Combobox.Portal>
                <OverlayLayerRoot interactive>
                    <Combobox.Content
                        forceMount
                        sideOffset={2}
                        collisionPadding={8}
                        class="risu-layer-overlay z-[var(--risu-overlay-z)] min-w-[var(--bits-combobox-anchor-width)] max-h-[var(--bits-combobox-content-available-height)] overflow-hidden rounded-md border border-darkborderc bg-darkbg p-1 shadow-lg outline-none"
                    >
                        <Combobox.Viewport class="max-h-[var(--bits-combobox-content-available-height)] overflow-y-auto">
                            {#each filteredOptions as option (option)}
                                <Combobox.Item
                                    value={option}
                                    label={option}
                                    class="block w-full cursor-pointer select-none truncate rounded px-2 py-1.5 text-left text-sm text-maintext outline-none data-highlighted:bg-selected"
                                >
                                    {option}
                                </Combobox.Item>
                            {/each}
                        </Combobox.Viewport>
                    </Combobox.Content>
                </OverlayLayerRoot>
            </Combobox.Portal>
        {/if}
    </Combobox.Root>
</div>
