<script lang="ts">
    import type { Snippet } from 'svelte';
    import Sortable, { type Options, type SortableEvent } from 'sortablejs';
    import { sortableOptions } from 'src/ts/util';

    interface Props {
        children: Snippet;
        element?: HTMLDivElement;
        containerKey?: string;
        className?: string;
        disabled?: boolean;
        draggable?: string;
        handle?: string;
        dataAttribute?: string;
        dataTransferKey?: string;
        dragPreviewText?: (key: string) => string | undefined;
        options?: Partial<Options>;
        onReorder: (orderedKeys: string[], event: SortableEvent) => void;
        onDragStart?: (key: string, event: SortableEvent) => void;
        onDragEnd?: (key: string, event: SortableEvent) => void;
    }

    let {
        children,
        element = $bindable(),
        containerKey,
        className = '',
        disabled = false,
        draggable = '[data-sortable-key]',
        handle,
        dataAttribute = 'data-sortable-key',
        dataTransferKey,
        dragPreviewText,
        options = {},
        onReorder,
        onDragStart = () => {},
        onDragEnd = () => {},
    }: Props = $props();

    let keysBeforeDrag: string[] = [];
    let dragOrigin: { parent: HTMLElement; nextSibling: ChildNode | null } | null = null;

    function itemKey(item: HTMLElement): string {
        return item.getAttribute(dataAttribute) ?? '';
    }

    function currentKeys(): string[] {
        return [...new Set(Array.from(element?.children ?? [])
            .filter((item): item is HTMLElement => item instanceof HTMLElement && item.matches(draggable))
            .map(itemKey)
            .filter(Boolean))];
    }

    function setDragData(dataTransfer: DataTransfer, dragElement: HTMLElement) {
        const key = itemKey(dragElement);
        if (dataTransferKey) dataTransfer.setData(dataTransferKey, key);
        dataTransfer.setData('text/plain', key);

        const previewText = dragPreviewText?.(key) ?? dragElement.dataset.disclosureDragName;
        const previewSource = handle
            ? dragElement.querySelector<HTMLElement>(handle) ?? dragElement
            : dragElement;
        const preview = previewText
            ? document.createElement('div')
            : previewSource.cloneNode(true) as HTMLElement;
        if (previewText) preview.textContent = previewText;
        preview.removeAttribute('id');
        preview.querySelectorAll('[id]').forEach(child => child.removeAttribute('id'));
        preview.setAttribute('aria-hidden', 'true');
        const previewRect = previewSource.getBoundingClientRect();
        preview.classList.add('risu-sortable-drag-preview');
        preview.style.position = 'fixed';
        preview.style.left = '-10000px';
        preview.style.top = '-10000px';
        preview.style.width = previewText ? 'max-content' : `${Math.min(previewRect.width, 280)}px`;
        preview.style.maxWidth = '280px';
        preview.style.maxHeight = '96px';
        preview.style.overflow = 'hidden';
        preview.style.pointerEvents = 'none';
        preview.style.opacity = '0.85';
        preview.style.transform = 'scale(0.9)';
        preview.style.transformOrigin = 'top left';
        preview.style.zIndex = '9999';
        if (previewText) {
            preview.className += ' px-4 py-2 rounded-sm text-sm whitespace-nowrap shadow-lg';
            preview.style.background = 'var(--risu-theme-darkbg)';
            preview.style.color = 'var(--risu-theme-textcolor2)';
        } else {
            const computedStyle = getComputedStyle(previewSource);
            preview.style.backgroundImage = 'none';
            preview.style.backgroundColor = computedStyle.backgroundColor;
            preview.style.color = computedStyle.color;
        }
        document.body.appendChild(preview);
        dataTransfer.setDragImage(preview, 10, 10);
        setTimeout(() => preview.remove(), 0);
    }

    $effect(() => {
        if (!element || disabled) return;

        const sortable = Sortable.create(element, {
            ...sortableOptions,
            animation: 150,
            chosenClass: 'risu-chosen-item',
            dragClass: 'risu-drag-item',
            ghostClass: 'risu-ghost-item',
            ...options,
            draggable,
            ...(handle ? { handle } : {}),
            setData: setDragData,
            onStart: (event) => {
                keysBeforeDrag = currentKeys();
                dragOrigin = {
                    parent: event.item.parentElement ?? event.from,
                    nextSibling: event.item.nextSibling,
                };
                onDragStart(itemKey(event.item), event);
            },
            onEnd: (event) => {
                const key = itemKey(event.item);
                const orderedKeys = [...keysBeforeDrag];
                const sourceIndex = orderedKeys.indexOf(key);
                const targetIndex = event.newDraggableIndex ?? event.newIndex;
                if (sourceIndex >= 0 && targetIndex !== undefined) {
                    orderedKeys.splice(sourceIndex, 1);
                    orderedKeys.splice(targetIndex, 0, key);
                }

                const oldDraggableIndex = event.oldDraggableIndex ?? event.oldIndex;
                try {
                    if (event.from !== event.to || oldDraggableIndex !== targetIndex) onReorder(orderedKeys, event);
                    onDragEnd(key, event);
                } finally {
                    // Sortable mutates the DOM before Svelte updates the keyed list. Restore Svelte's
                    // expected pre-drag DOM so its next reconciliation applies the data order cleanly.
                    if (dragOrigin) {
                        const { parent, nextSibling } = dragOrigin;
                        parent.insertBefore(event.item, nextSibling?.parentNode === parent ? nextSibling : null);
                    }
                    keysBeforeDrag = [];
                    dragOrigin = null;
                }
            },
        });

        return () => {
            try {
                sortable.destroy();
            } catch (_) {}
        };
    });
</script>

<div bind:this={element} class={className} data-risu-sortable-list data-sortable-container-key={containerKey}>
    {@render children()}
</div>

<style>
    :global(.risu-ghost-item) {
        opacity: 0.45;
    }

    :global(.risu-ghost-item:not([data-disclosure-divider-tone]):not([data-sortable-no-scale])) {
        scale: 0.95;
        transform-origin: center;
    }
</style>
