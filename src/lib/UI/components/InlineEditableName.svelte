<script lang="ts">
    import { onDestroy, tick, type ComponentProps, type Snippet } from 'svelte';
    import InlineNameInput from './InlineNameInput.svelte';
    import type { InlineEditableNameController } from './InlineEditableNameController.svelte';

    interface Props {
        value?: string;
        label?: string;
        size?: ComponentProps<typeof InlineNameInput>['size'];
        editorLeadingInset?: 'border' | 'row';
        placeholder?: string;
        disabled?: boolean;
        className?: string;
        controller?: InlineEditableNameController;
        display?: Snippet;
        onActivate?: () => void;
        onValueChange?: (value: string) => void;
        onCommit?: (value: string) => void;
    }

    let {
        value = $bindable(''),
        label,
        size = 'default',
        editorLeadingInset = 'border',
        placeholder = '',
        disabled = false,
        className = '',
        controller,
        display,
        onActivate,
        onValueChange,
        onCommit,
    }: Props = $props();

    let editing = $state(false);
    let root: HTMLDivElement;
    let originalValue = '';
    let clickBlockTimeout: ReturnType<typeof setTimeout> | undefined;
    const outsideClickBlockDuration = 500;

    function consumeClick(event: MouseEvent) {
        event.preventDefault();
        event.stopImmediatePropagation();
        window.removeEventListener('click', consumeClick, true);
        if (clickBlockTimeout !== undefined) clearTimeout(clickBlockTimeout);
        clickBlockTimeout = undefined;
    }

    function blockFollowingClick() {
        window.removeEventListener('click', consumeClick, true);
        window.addEventListener('click', consumeClick, true);
        if (clickBlockTimeout !== undefined) clearTimeout(clickBlockTimeout);
        clickBlockTimeout = setTimeout(() => {
            window.removeEventListener('click', consumeClick, true);
            clickBlockTimeout = undefined;
        }, outsideClickBlockDuration);
    }

    function finishFromOutsidePointer(event: PointerEvent) {
        if (!editing || !(event.target instanceof Node) || root.contains(event.target)) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        blockFollowingClick();
        const input = root.querySelector('input');
        if (input instanceof HTMLInputElement) input.blur();
        else finishEditing();
    }
    async function startEditing(event?: Event) {
        if (disabled || editing) return;
        event?.preventDefault();
        event?.stopPropagation();
        originalValue = value;
        editing = true;
        await tick();
        const input = root.querySelector('input');
        if (input) {
            input.focus();
            const cursorPosition = input.value.length;
            input.setSelectionRange(cursorPosition, cursorPosition);
        }
    }

    $effect(() => {
        if (!controller) return;
        controller.connect(startEditing);
        return () => controller.disconnect(startEditing);
    });

    $effect(() => {
        controller?.updateStatus(disabled, editing);
    });

    function handleClick(event: MouseEvent) {
        if (disabled) return;
        event.stopPropagation();
        if (editing) return;
        onActivate?.();
    }

    function finishEditing() {
        editing = false;
        if (value !== originalValue) onCommit?.(value);
    }

    $effect(() => {
        if (!editing) return;
        window.addEventListener('pointerdown', finishFromOutsidePointer, true);
        return () => window.removeEventListener('pointerdown', finishFromOutsidePointer, true);
    });

    onDestroy(() => {
        window.removeEventListener('click', consumeClick, true);
        if (clickBlockTimeout !== undefined) clearTimeout(clickBlockTimeout);
    });

    function handleKeydown(event: KeyboardEvent) {
        event.stopPropagation();
        if (event.key === 'Enter') {
            event.preventDefault();
            event.currentTarget instanceof HTMLInputElement && event.currentTarget.blur();
        } else if (event.key === 'Escape') {
            event.preventDefault();
            value = originalValue;
            onValueChange?.(originalValue);
            event.currentTarget instanceof HTMLInputElement && event.currentTarget.blur();
        }
    }
</script>

<!-- This composite control owns its label/input gestures; the rename action can live in a sibling action group. -->
<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<div
    bind:this={root}
    role="group"
    class="editable-name flex min-w-0 grow items-center {className}"
    onclick={handleClick}
    onkeydown={(event) => event.stopPropagation()}
>
    {#if editing}
        <InlineNameInput
            bind:value
            data-inline-name-editor
            {size}
            leadingInset={editorLeadingInset}
            {placeholder}
            className="no-sort"
            onblur={finishEditing}
            oninput={(event) => onValueChange?.(event.currentTarget.value)}
            onkeydown={handleKeydown}
            onclick={(event) => event.stopPropagation()}
            onpointerdown={(event) => event.stopPropagation()}
        />
    {:else}
        <span class="min-w-0 grow truncate text-left">
            {#if display}
                {@render display()}
            {:else}
                {label ?? value}
            {/if}
        </span>
    {/if}
</div>
