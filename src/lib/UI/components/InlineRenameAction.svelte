<script lang="ts">
    import { PencilIcon } from '@lucide/svelte';
    import { language } from 'src/lang';
    import IconButton from './IconButton.svelte';
    import type { InlineEditableNameController } from './InlineEditableNameController.svelte';

    interface Props {
        controller?: InlineEditableNameController;
        title?: string;
        onclick?: (event: MouseEvent) => void;
    }

    let {
        controller,
        title = language.togglePresetMenuRename,
        onclick,
    }: Props = $props();

    function handleClick(event: MouseEvent) {
        if (controller) controller.startEditing(event);
        else {
            event.preventDefault();
            event.stopPropagation();
            onclick?.(event);
        }
    }
</script>

{#if onclick || (controller?.connected && !controller.disabled && !controller.editing)}
    <IconButton
        className="inline-rename-action no-sort"
        data-inline-rename-action
        {title}
        aria-label={title}
        onclick={handleClick}
    >
        <PencilIcon />
    </IconButton>
{/if}

<style>
    :global([data-inline-rename-action]) {
        opacity: 0;
        pointer-events: none;
        transition: opacity 150ms ease;
    }

    @media (hover: hover) and (pointer: fine) {
        :global([data-inline-rename-row]:hover [data-inline-rename-action]),
        :global([data-inline-rename-row]:has(:focus-visible) [data-inline-rename-action]),
        :global([data-inline-rename-action]:focus-visible) {
            opacity: 1;
            pointer-events: auto;
        }
    }

    @media (hover: none), (pointer: coarse) {
        :global([data-inline-rename-action]) {
            opacity: 1;
            pointer-events: auto;
        }
    }
</style>
