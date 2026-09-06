<script lang="ts">
    import type { Snippet } from "svelte";
    import type { HTMLAttributes } from "svelte/elements";
    import { cn } from "src/lib/utils";

    type Props = HTMLAttributes<HTMLDivElement> & {
        variant?: 'list' | 'item';
        appearance?: 'divided' | 'folder' | 'row';
        element?: HTMLDivElement;
        background?: boolean;
        open?: boolean;
        disclosure?: boolean;
        isLast?: boolean;
        dividerTone?: 'default' | 'muted';
        className?: string;
        headerClass?: string;
        inlineRenameRow?: boolean;
        bodyClass?: string;
        bodyPadded?: boolean;
        onToggle?: () => void;
        header?: Snippet;
        actions?: Snippet;
        children?: Snippet;
    };

    let {
        variant = 'list',
        appearance = 'divided',
        element = $bindable(),
        background = true,
        open = false,
        disclosure = true,
        isLast,
        dividerTone = 'default',
        className = '',
        headerClass = '',
        inlineRenameRow = false,
        bodyClass = '',
        bodyPadded = true,
        onToggle = () => {},
        header,
        actions,
        children,
        ...rest
    }: Props = $props();

    const listClasses = $derived(cn(
        'w-full max-w-full flex flex-col',
        appearance === 'divided' ? 'p-2 border border-selected rounded-md' : 'gap-1',
        appearance === 'divided' && background && 'bg-darkbg',
        className,
    ));
    const itemClasses = $derived(cn(
        'w-full flex flex-col',
        appearance === 'folder' && 'risu-folder-section',
        appearance === 'divided' && [
            dividerTone === 'muted' ? 'border-darkborderc/50' : 'border-selected',
            isLast === true
                ? 'pb-0 mb-0 border-0'
                : isLast === false
                    ? 'pb-1 mb-1 border-b'
                    : 'pb-1 mb-1 border-b last:pb-0 last:mb-0 last:border-0',
        ],
        className,
    ));
    const headerClasses = $derived(cn(
        'w-full transition-colors [&>button]:cursor-pointer',
        appearance !== 'divided'
            ? 'risu-folder-header risu-selectable-row'
            : 'flex min-h-6 items-center p-1',
        headerClass,
    ));
    const bodyClasses = $derived(cn(
        'flex flex-col',
        appearance === 'divided' ? 'mt-2' : 'mt-1',
        appearance === 'folder' ? 'risu-folder-children' : 'w-full',
        '[&_[data-disclosure-field]]:mt-2 [&_[data-disclosure-field]]:flex [&_[data-disclosure-field]]:flex-col',
        '[&_[data-disclosure-label]]:flex [&_[data-disclosure-label]]:items-center [&_[data-disclosure-label]]:text-maintext',
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
        preview.className = 'risu-layer-overlay absolute -top-96 -left-96 px-4 py-2 bg-darkbg text-subtext rounded-sm text-sm whitespace-nowrap shadow-lg pointer-events-none';
        document.body.appendChild(preview);
        event.dataTransfer.setDragImage(preview, 10, 10);
        setTimeout(() => preview.remove(), 0);
    }
</script>

{#if variant === 'item'}
    <div {...rest} bind:this={element} class={itemClasses} data-disclosure-divider-tone={dividerTone}>
        <div
            class={headerClasses}
            data-disclosure-header
            data-inline-rename-row={inlineRenameRow ? '' : undefined}
        >
            <div
                role="button"
                tabindex="0"
                class="flex min-w-0 grow cursor-pointer items-center text-left"
                class:risu-interactive-accent={appearance === 'divided'}
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
    <div
        {...rest}
        bind:this={element}
        class={listClasses}
        data-disclosure-background={appearance === 'divided' && background ? 'filled' : 'transparent'}
        ondragstart={createDragPreview}
    >
        {@render children?.()}
    </div>
{/if}

<style>
    :global(.risu-ghost-item) {
        border-color: var(--risu-theme-selected);
        opacity: 0.7;
    }

    :global([data-disclosure-background="filled"] > .risu-ghost-item) {
        background-color: var(--risu-theme-darkbg);
    }

    /* A list item owns the full-width divider, so scaling its root also
       shrinks the divider. Keep row-shaped ghosts full width and reserve
       the scale effect for card-shaped draggable containers. */
    :global(.risu-ghost-item:not([data-disclosure-divider-tone]):not([data-sortable-no-scale])) {
        scale: 0.95;
        transform-origin: center;
    }

    :global(.risu-drag-item [data-disclosure-toggle].risu-interactive-accent),
    :global(.risu-ghost-item [data-disclosure-toggle].risu-interactive-accent) {
        color: var(--risu-theme-primary);
    }

    :global([data-disclosure-action="delete"]) {
        color: var(--risu-theme-subtext);
    }

    :global([data-disclosure-divider-tone="muted"] > [data-disclosure-header] > [data-disclosure-actions] > button:not([data-disclosure-action="delete"]):is(:hover, :focus-visible)) {
        color: var(--risu-theme-primary);
    }

    :global([data-disclosure-action="delete"]:is(:hover, :focus-visible)),
    :global([data-disclosure-divider-tone="muted"] > [data-disclosure-header] > [data-disclosure-actions] > [data-disclosure-action="delete"]:is(:hover, :focus-visible)) {
        color: var(--risu-theme-danger);
    }
</style>
