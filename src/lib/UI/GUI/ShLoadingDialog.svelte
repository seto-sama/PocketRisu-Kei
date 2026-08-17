<script lang="ts">
    // Blocking loading modal — shadcn-pattern dialog for long-running operations
    // that must prevent user interaction (backup/restore, import, translation,
    // screenshot, etc.). Non-closable by design: no X button, ESC blocked,
    // outside click blocked. Shows a spinner + message, and an optional
    // progress bar when a percentage is provided.
    import type { Snippet } from 'svelte';
    import { LoaderCircleIcon } from '@lucide/svelte';
    import { cn } from 'src/lib/utils';
    import ShDialog, { type ShDialogTier } from './ShDialog.svelte';

    interface Props {
        open?: boolean;
        message?: string;
        submessage?: string;
        progress?: number | null;
        tier?: ShDialogTier;
        contentClass?: string;
        extra?: Snippet;
    }

    let {
        open = $bindable(false),
        message = '',
        submessage = '',
        progress = null,
        tier = 'alert',
        contentClass = '',
        extra,
    }: Props = $props();

    const clampedProgress = $derived(
        progress == null ? null : Math.max(0, Math.min(100, progress))
    );

</script>

<ShDialog
    bind:open
    {tier}
    closable={false}
    closeOnEscape={false}
    closeOnOutsideClick={false}
    ariaLabel={message || 'Loading in progress. Please wait.'}
    contentClass={cn('p-6', contentClass)}
    bodyClass="w-full flex flex-col gap-4 items-center"
>
    <LoaderCircleIcon class="size-8 text-borderc animate-spin shrink-0" />

    {#if message}
        <div class="text-textcolor text-center whitespace-pre-wrap break-words">
            {message}
        </div>
    {/if}

    {#if submessage}
        <div class="text-textcolor2 text-sm text-center whitespace-pre-wrap break-words">
            {submessage}
        </div>
    {/if}

    {#if clampedProgress != null}
        <div class="w-full flex flex-col gap-2 mt-2">
            <div class="w-full h-2 bg-bgcolor border border-darkborderc rounded-md overflow-hidden">
                <div
                    class="h-full bg-linear-to-r risu-saving-gradient saving-animation transition-[width]"
                    style:width={clampedProgress + '%'}
                ></div>
            </div>
            <div class="text-textcolor2 text-sm text-center">
                {clampedProgress.toFixed(0)}%
            </div>
        </div>
    {/if}

    {#if extra}
        {@render extra()}
    {/if}
</ShDialog>
