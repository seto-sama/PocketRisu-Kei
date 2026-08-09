<script lang="ts">
    import type { Snippet } from "svelte";
    import type { HTMLAttributes } from "svelte/elements";
    import { cn } from "src/lib/utils";

    type Props = HTMLAttributes<HTMLDivElement> & {
        variant?: 'list' | 'item';
        element?: HTMLDivElement;
        background?: boolean;
        open?: boolean;
        disclosure?: boolean;
        isLast?: boolean;
        dividerTone?: 'default' | 'muted';
        className?: string;
        headerClass?: string;
        bodyClass?: string;
        bodyPadded?: boolean;
        onToggle?: () => void;
        header?: Snippet;
        actions?: Snippet;
        children?: Snippet;
    };

    let {
        variant = 'list',
        element = $bindable(),
        background = true,
        open = false,
        disclosure = true,
        isLast,
        dividerTone = 'default',
        className = '',
        headerClass = '',
        bodyClass = '',
        bodyPadded = true,
        onToggle = () => {},
        header,
        actions,
        children,
        ...rest
    }: Props = $props();

    const listClasses = $derived(cn(
        'w-full max-w-full p-2 border border-selected flex flex-col rounded-md',
        background && 'bg-darkbg',
        className,
    ));
    const itemClasses = $derived(cn(
        'w-full flex flex-col',
        dividerTone === 'muted' ? 'border-darkborderc/50' : 'border-selected',
        isLast === true
            ? 'pb-0 mb-0 border-0'
            : isLast === false
                ? 'pb-1 mb-1 border-b'
                : 'pb-1 mb-1 border-b last:pb-0 last:mb-0 last:border-0',
        className,
    ));
    const headerClasses = $derived(cn(
        'flex min-h-6 w-full items-center p-1 transition-colors [&>button]:cursor-pointer',
        headerClass,
    ));
    const bodyClasses = $derived(cn(
        'mt-2 w-full flex flex-col',
        '[&_[data-disclosure-field]]:mt-2 [&_[data-disclosure-field]]:flex [&_[data-disclosure-field]]:flex-col',
        '[&_[data-disclosure-label]]:flex [&_[data-disclosure-label]]:items-center [&_[data-disclosure-label]]:text-textcolor',
        '[&_[data-disclosure-control]]:mt-2 [&_[data-disclosure-control]]:mb-2 [&_[data-disclosure-control]]:flex [&_[data-disclosure-control]]:w-full [&_[data-disclosure-control]]:flex-col',
        '[&_[data-disclosure-row]]:mt-2 [&_[data-disclosure-row]]:mb-2 [&_[data-disclosure-row]]:flex [&_[data-disclosure-row]]:items-center [&_[data-disclosure-row]]:justify-between',
        bodyPadded && 'p-1',
        bodyClass,
    ));

    function createDragPreview(event: DragEvent) {
        if ((event.currentTarget as HTMLElement).closest('[data-risu-sortable-list]')) return;
        const target = event.target as HTMLElement | null;
        const item = target?.closest<HTMLElement>('[data-disclosure-drag-name]');
        const name = item?.dataset.disclosureDragName;
        if (!name || !event.dataTransfer) return;

        const preview = document.createElement('div');
        preview.textContent = name;
        preview.className = 'absolute -top-96 -left-96 px-4 py-2 bg-darkbg text-textcolor2 rounded-sm text-sm whitespace-nowrap shadow-lg pointer-events-none z-50';
        document.body.appendChild(preview);
        event.dataTransfer.setDragImage(preview, 10, 10);
        setTimeout(() => preview.remove(), 0);
    }
</script>

{#if variant === 'item'}
    <div {...rest} bind:this={element} class={itemClasses} data-disclosure-divider-tone={dividerTone}>
        <div class={headerClasses} data-disclosure-header>
            <div
                role="button"
                tabindex="0"
                class="flex min-w-0 grow cursor-pointer items-center text-left risu-interactive-accent"
                data-disclosure-toggle
                aria-expanded={disclosure ? open : undefined}
                onclick={onToggle}
                onkeydown={(event) => {
                    if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault()
                        onToggle()
                    }
                }}
            >
                {@render header?.()}
            </div>
            <div class="no-sort flex shrink-0 items-center [&>button]:cursor-pointer" data-disclosure-actions>
                {@render actions?.()}
            </div>
        </div>
        {#if open}
            <div class={bodyClasses}>
                {@render children?.()}
            </div>
        {/if}
    </div>
{:else}
    <div {...rest} bind:this={element} class={listClasses} ondragstart={createDragPreview}>
        {@render children?.()}
    </div>
{/if}

<style>
    :global(.risu-ghost-item) {
        background-color: var(--risu-theme-darkbg);
        border-color: var(--risu-theme-selected);
        opacity: 0.7;
    }

    /* A list item owns the full-width divider, so scaling its root also
       shrinks the divider. Keep row-shaped ghosts full width and reserve
       the scale effect for card-shaped draggable containers. */
    :global(.risu-ghost-item:not([data-disclosure-divider-tone]):not([data-sortable-no-scale])) {
        scale: 0.95;
        transform-origin: center;
    }

    :global(.risu-drag-item [data-disclosure-toggle]),
    :global(.risu-ghost-item [data-disclosure-toggle]) {
        color: var(--risu-theme-primary);
    }

    :global([data-disclosure-action="delete"]) {
        color: var(--risu-theme-textcolor2);
    }

    :global([data-disclosure-divider-tone="muted"] > [data-disclosure-header] > [data-disclosure-actions] > button:not([data-disclosure-action="delete"]):is(:hover, :focus-visible)) {
        color: var(--risu-theme-primary);
    }

    :global([data-disclosure-action="delete"]:is(:hover, :focus-visible)),
    :global([data-disclosure-divider-tone="muted"] > [data-disclosure-header] > [data-disclosure-actions] > [data-disclosure-action="delete"]:is(:hover, :focus-visible)) {
        color: var(--risu-theme-draculared);
    }
</style>
