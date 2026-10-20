<script lang="ts">
    import type { Snippet } from 'svelte';
    import { LoaderIcon } from '@lucide/svelte';
    import { language } from 'src/lang';
    import Dialog from './Dialog.svelte';

    interface Props {
        open?: boolean;
        title?: string;
        message?: string;
        submessage?: string;
        progress?: number | null;
        progressDetail?: string;
        icon?: Snippet;
        footer?: Snippet;
        children?: Snippet;
    }

    let {
        open = $bindable(false),
        title: dialogTitle = language.loading,
        message = '',
        submessage = '',
        progress = null,
        progressDetail = '',
        icon,
        footer,
        children,
    }: Props = $props();

    const clampedProgress = $derived(
        progress == null ? null : Math.max(0, Math.min(100, progress))
    );
</script>

<Dialog bind:open closable={false} dismissible={false} size="sm" {footer}>
    {#snippet title()}
        <span class="inline-flex items-center gap-2.5">
            {#if icon}
                {@render icon()}
            {:else}
                <span class="p-2 rounded-full bg-primary/20 shrink-0" aria-hidden="true">
                    <LoaderIcon size={20} class="text-primary animate-spin" />
                </span>
            {/if}
            <span>{dialogTitle}</span>
        </span>
    {/snippet}

    {#if message}
        <p class="text-sm text-subtext leading-relaxed break-words">{message}</p>
    {/if}
    {#if submessage}
        <p class="mt-2 text-sm text-subtext leading-relaxed break-words">{submessage}</p>
    {/if}

    {@render children?.()}

    {#if clampedProgress != null}
        <div class="mt-3 w-full bg-selected rounded-full h-2 overflow-hidden">
            <div
                class="h-full bg-linear-to-r risu-saving-gradient saving-animation rounded-full"
                style:width={clampedProgress + '%'}
            ></div>
        </div>
        <p class="mt-1 text-xs text-subtext text-right">
            {#if progressDetail}{progressDetail} · {/if}{Math.floor(clampedProgress)}%
        </p>
    {/if}
</Dialog>
