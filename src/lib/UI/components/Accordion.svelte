<script lang="ts" module>
    // Single-section disclosure. The codebase has no multi-item accordion
    // grouping, so the compact Accordion name is retained for call-site clarity.
    export type AccordionVariant = 'card' | 'plain' | 'indent';

    let _shAccordionId = 0;
</script>

<script lang="ts">
    import { ChevronDownIcon } from '@lucide/svelte';
    import { cn } from 'src/lib/utils';
    import type { Snippet } from 'svelte';

    interface Props {
        name?: string;
        variant?: AccordionVariant;
        open?: boolean;
        disabled?: boolean;
        trigger?: Snippet;
        extras?: Snippet;
        children?: Snippet;
        class?: string;
        bodyClass?: string;
    }

    let {
        name = '',
        variant = 'card',
        open = $bindable(false),
        disabled = false,
        trigger,
        extras,
        children,
        class: className = '',
        bodyClass = '',
    }: Props = $props();

    const uid = ++_shAccordionId;
    const triggerId = `sh-acc-trigger-${uid}`;
    const contentId = `sh-acc-content-${uid}`;

    const wrapperClass = $derived(
        variant === 'card'
            ? 'border border-darkborderc rounded-md overflow-hidden'
            : 'flex flex-col'
    );

    const bodyInnerClass = $derived(
        variant === 'card'
            ? 'border-t border-darkborderc p-2'
            : variant === 'indent'
                ? 'ml-3 pl-3 border-l border-darkborderc py-1'
                : ''
    );

    const triggerBase =
        'h-10 inline-flex items-center gap-2 border border-transparent text-base font-medium text-left ' +
        'disabled:opacity-50 disabled:pointer-events-none';
</script>

<div class={cn(wrapperClass, className)}>
    <div class="flex items-stretch transition-colors risu-interactive-surface has-[:focus-visible]:bg-selected/30">
        {#if extras}
            <button
                id={triggerId}
                type="button"
                {disabled}
                aria-expanded={open}
                aria-controls={contentId}
                class={cn(triggerBase, 'min-w-0 pl-3 pr-0')}
                onclick={() => (open = !open)}
            >
                {#if trigger}
                    {@render trigger()}
                {:else}
                    <span class="truncate">{name}</span>
                {/if}
            </button>
            <div class="pl-1 flex items-center shrink-0 [&_[data-risu-help]]:ml-0">
                {@render extras()}
            </div>
            <button
                type="button"
                {disabled}
                aria-label={name}
                aria-expanded={open}
                aria-controls={contentId}
                class="h-10 min-w-8 flex flex-1 items-center justify-end pl-2 pr-3 disabled:pointer-events-none disabled:opacity-50"
                onclick={() => (open = !open)}
            >
                <ChevronDownIcon
                    size={16}
                    class={cn(
                        'shrink-0 transition-transform duration-150',
                        open && 'rotate-180'
                    )}
                />
            </button>
        {:else}
            <button
                id={triggerId}
                type="button"
                {disabled}
                aria-expanded={open}
                aria-controls={contentId}
                class={cn(triggerBase, 'flex-1 min-w-0 justify-between px-3')}
                onclick={() => (open = !open)}
            >
                <span class="flex-1 inline-flex items-center gap-2 min-w-0">
                    {#if trigger}
                        {@render trigger()}
                    {:else}
                        <span class="truncate">{name}</span>
                    {/if}
                </span>
                <ChevronDownIcon
                    size={16}
                    class={cn(
                        'shrink-0 transition-transform duration-150',
                        open && 'rotate-180'
                    )}
                />
            </button>
        {/if}
    </div>
    <div
        id={contentId}
        role="region"
        aria-labelledby={triggerId}
        aria-hidden={!open}
        inert={!open}
        class="grid transition-[grid-template-rows] duration-150"
        class:hidden={!open}
        style:grid-template-rows={open ? '1fr' : '0fr'}
    >
        <div class="overflow-hidden">
            <div class={cn(bodyInnerClass, bodyClass)}>
                {@render children?.()}
            </div>
        </div>
    </div>
</div>
