<script lang="ts">
    import { RadioGroup, ToggleGroup } from 'bits-ui';
    import { cn } from 'src/lib/utils';
    import ShTooltip from './ShTooltip.svelte';

    interface ChoiceOption {
        value: string;
        label: string;
        description?: string;
    }

    interface Props {
        mode?: 'single' | 'multiple';
        value?: string;
        values?: string[];
        options?: ChoiceOption[];
        name?: string;
        disabled?: boolean;
        variant?: 'default' | 'pill' | 'grid';
        size?: 'sm' | 'md';
        activeColor?: 'primary' | 'selected';
        fullWidth?: boolean;
        divided?: boolean;
        columns?: 2 | 3 | 4;
        onValueChange?: (value: string) => void;
        onValuesChange?: (values: string[]) => void;
        className?: string;
    }

    let {
        mode = 'single',
        value = $bindable(''),
        values = $bindable([]),
        options = [],
        name,
        disabled = false,
        variant = 'default',
        size = 'sm',
        activeColor = 'primary',
        fullWidth = false,
        divided = false,
        columns = 2,
        onValueChange,
        onValuesChange,
        className = '',
    }: Props = $props();

    const rootClass = $derived(cn(
        variant === 'default' && 'flex flex-col gap-0.5',
        variant === 'pill' && 'inline-flex overflow-hidden rounded-md border border-darkborderc',
        variant === 'pill' && fullWidth && 'flex w-full',
        variant === 'grid' && 'grid w-full overflow-hidden rounded-md border border-darkborderc',
        variant === 'grid' && columns === 2 && 'grid-cols-2',
        variant === 'grid' && columns === 3 && 'grid-cols-3',
        variant === 'grid' && columns === 4 && 'grid-cols-4',
        className,
    ));

    function groupedItemClass(index: number) {
        return cn(
            'cursor-pointer select-none bg-transparent text-subtext transition-colors',
            'disabled:cursor-not-allowed disabled:opacity-50',
            size === 'sm' ? 'px-2 py-1 text-xs' : 'px-3 py-1.5 text-sm',
            variant === 'pill' && fullWidth && 'flex min-w-0 flex-1 items-center justify-center text-center',
            variant === 'pill' && divided && 'border-r border-darkborderc last:border-r-0',
            variant === 'grid' && 'flex w-full items-center justify-center text-center',
            variant === 'grid' && index % columns !== columns - 1 && 'border-r border-darkborderc',
            variant === 'grid' && Math.floor(index / columns) < Math.ceil(options.length / columns) - 1 && 'border-b border-darkborderc',
            activeColor === 'primary' && [
                'risu-interactive-surface',
                'data-[state=checked]:bg-primary data-[state=checked]:text-themewhite',
                'data-[state=on]:bg-primary data-[state=on]:text-themewhite',
            ],
            activeColor === 'selected' && [
                'data-[state=unchecked]:risu-interactive-surface-strong data-[state=off]:risu-interactive-surface-strong',
                'data-[state=checked]:bg-selected data-[state=checked]:text-maintext',
                'data-[state=on]:bg-selected data-[state=on]:text-maintext',
            ],
        );
    }
</script>

{#if mode === 'multiple'}
    <ToggleGroup.Root
        type="multiple"
        bind:value={values}
        onValueChange={onValuesChange}
        {disabled}
        orientation={variant === 'default' ? 'vertical' : 'horizontal'}
        class={rootClass}
    >
        {#each options as opt, index (opt.value)}
            <ToggleGroup.Item value={opt.value} class={groupedItemClass(index)}>
                {opt.label}
            </ToggleGroup.Item>
        {/each}
    </ToggleGroup.Root>
{:else}
    <RadioGroup.Root
        bind:value
        {name}
        {disabled}
        orientation={variant === 'default' ? 'vertical' : 'horizontal'}
        class={rootClass}
        onValueChange={onValueChange}
    >
        {#each options as opt, index (opt.value)}
            {#if variant === 'default'}
                <RadioGroup.Item
                    value={opt.value}
                    class={cn(
                        'group flex w-full gap-2.5 rounded-md border border-transparent px-1 py-1.5 text-left text-sm text-maintext transition-colors',
                        opt.description ? 'items-start' : 'items-center',
                        'risu-interactive-surface disabled:cursor-not-allowed disabled:opacity-50',
                    )}
                >
                    <span class={cn('relative size-4 shrink-0 rounded-full border border-darkborderc transition-colors group-data-[state=checked]:border-primary', opt.description && 'mt-0.5')}>
                        <span class="absolute left-1/2 top-1/2 size-2 -translate-x-1/2 -translate-y-1/2 rounded-full bg-primary opacity-0 transition-opacity group-data-[state=checked]:opacity-100"></span>
                    </span>
                    <span class="min-w-0">
                        <span>{opt.label}</span>
                        {#if opt.description}
                            <span class="block text-xs text-subtext">{opt.description}</span>
                        {/if}
                    </span>
                </RadioGroup.Item>
            {:else}
                {#if opt.description}
                    <ShTooltip>
                        {#snippet trigger(props)}
                            <RadioGroup.Item {...props} value={opt.value} class={groupedItemClass(index)}>
                                {opt.label}
                            </RadioGroup.Item>
                        {/snippet}
                        <span class="whitespace-pre-line">{opt.description}</span>
                    </ShTooltip>
                {:else}
                    <RadioGroup.Item value={opt.value} class={groupedItemClass(index)}>
                        {opt.label}
                    </RadioGroup.Item>
                {/if}
            {/if}
        {/each}
    </RadioGroup.Root>
{/if}
