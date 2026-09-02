<script lang="ts">
    import type { Snippet } from 'svelte';
    import { ChevronLeftIcon, ChevronRightIcon, InfoIcon, LoaderCircleIcon, XIcon } from '@lucide/svelte';
    import OverlayPortal from './overlay/OverlayPortal.svelte';
    import IconButton from './IconButton.svelte';
    import IconButtonGroup from './IconButtonGroup.svelte';
    import { createSingleFlightRunner } from 'src/ts/util/singleFlight';

    interface Props {
        open?: boolean;
        src?: string;
        alt?: string;
        title?: string;
        subtitle?: string;
        position?: number;
        total?: number;
        loading?: boolean;
        error?: string;
        loadingLabel?: string;
        canGoPrev?: boolean;
        canGoNext?: boolean;
        metadataLabel?: string;
        closeLabel?: string;
        previousLabel?: string;
        nextLabel?: string;
        onClose: () => void;
        onPrev?: () => void;
        onNext?: () => void;
        onDelete?: () => void | Promise<void>;
        onDownload?: () => void | Promise<void>;
        viewerContent?: Snippet;
        actions?: Snippet;
        metadataOverlay?: Snippet;
    }

    let {
        open = false,
        src = '',
        alt = '',
        title = '',
        subtitle = '',
        position = -1,
        total = 0,
        loading = false,
        error = '',
        loadingLabel = 'Loading...',
        canGoPrev = false,
        canGoNext = false,
        metadataLabel = 'Info',
        closeLabel = 'Close',
        previousLabel = 'Previous image',
        nextLabel = 'Next image',
        onClose,
        onPrev,
        onNext,
        onDelete,
        onDownload,
        viewerContent,
        actions,
        metadataOverlay,
    }: Props = $props();
    let metadataOpen = $state(true);
    const runShortcutAction = createSingleFlightRunner('ImageViewerShortcut');

    function handleKeydown(event: KeyboardEvent) {
        if(!open){
            return
        }
        if(event.key === 'Delete' && onDelete){
            event.preventDefault()
            runShortcutAction('delete', onDelete)
        }
        else if(event.key.toLowerCase() === 's' && (event.ctrlKey || event.metaKey) && onDownload){
            event.preventDefault()
            runShortcutAction('download', onDownload)
        }
        else if(event.key === 'ArrowLeft' && canGoPrev){
            event.preventDefault()
            onPrev?.()
        }
        else if(event.key === 'ArrowRight' && canGoNext){
            event.preventDefault()
            onNext?.()
        }
    }

    function handleBackdropClick(event: MouseEvent) {
        if(event.target === event.currentTarget){
            onClose()
        }
    }
</script>

<svelte:window onkeydown={handleKeydown} />

{#if open}
    <OverlayPortal onEscape={onClose}>
    <!-- Base tier keeps blocking alerts such as delete confirmation above the viewer. -->
    <div class="risu-layer-overlay fixed inset-0 flex h-dvh overflow-hidden bg-lightbg text-maintext">
        <div class="relative flex flex-1 min-w-0 items-center justify-center overflow-hidden">
            <div class="absolute top-0 inset-x-0 z-10 flex items-center gap-3 px-4 py-3 bg-gradient-to-b from-darkbg/90 to-transparent pointer-events-none">
                <div class="flex-1 min-w-0">
                    <p class="text-maintext text-sm font-semibold truncate">{title}</p>
                    {#if subtitle || (position >= 0 && total > 0)}
                        <p class="flex min-w-0 items-center gap-2 text-subtext text-xs">
                            {#if subtitle}<span class="truncate">{subtitle}</span>{/if}
                            {#if subtitle && position >= 0 && total > 0}<span class="h-3 w-px shrink-0 bg-subtext/40"></span>{/if}
                            {#if position >= 0 && total > 0}<span class="shrink-0">{position + 1}/{total}</span>{/if}
                        </p>
                    {/if}
                </div>
                <IconButtonGroup size="lg" cellSize={32} className="shrink-0 gap-1 pointer-events-auto [&_[data-icon-button]]:rounded-sm [&_[data-icon-button]]:risu-interactive-surface">
                    {#if metadataOverlay}
                        <IconButton
                            onclick={() => (metadataOpen = !metadataOpen)}
                            title={metadataLabel}
                            aria-label={metadataLabel}
                            aria-pressed={metadataOpen}
                            active={metadataOpen}
                            className="text-maintext"
                        >
                            <InfoIcon />
                        </IconButton>
                    {/if}
                    {#if actions}
                        {@render actions()}
                    {/if}
                    <IconButton
                        onclick={onClose}
                        title={closeLabel}
                        aria-label={closeLabel}
                        className="text-maintext"
                    >
                        <XIcon />
                    </IconButton>
                </IconButtonGroup>
            </div>

            {#if canGoPrev}
                <button
                    type="button"
                    class="absolute left-3 z-10 w-11 h-11 rounded-md bg-transparent risu-interactive-surface flex items-center justify-center text-maintext transition-colors"
                    onclick={onPrev}
                    aria-label={previousLabel}
                >
                    <ChevronLeftIcon size={20} class="-translate-x-px" />
                </button>
            {/if}

            <div
                class="w-full h-full flex items-center justify-center px-16 py-14"
                role="presentation"
                onclick={handleBackdropClick}
            >
                {#if loading}
                    <div class="flex flex-col items-center gap-4">
                        <LoaderCircleIcon class="size-12 animate-spin text-primary" />
                        <p class="text-subtext text-sm">{loadingLabel}</p>
                    </div>
                {:else if error}
                    <p class="text-danger text-sm">{error}</p>
                {:else if viewerContent}
                    {@render viewerContent()}
                {:else if src}
                    <img
                        {src}
                        {alt}
                        class="max-w-full max-h-full object-contain rounded shadow-2xl"
                    />
                {/if}
            </div>

            {#if canGoNext}
                <button
                    type="button"
                    class="absolute right-3 z-10 w-11 h-11 rounded-md bg-transparent risu-interactive-surface flex items-center justify-center text-maintext transition-colors"
                    onclick={onNext}
                    aria-label={nextLabel}
                >
                    <ChevronRightIcon size={20} class="translate-x-px" />
                </button>
            {/if}

            {#if metadataOpen && metadataOverlay}
                <div class="absolute bottom-3 left-3 right-3 z-10 max-h-[calc(100%-4.25rem)] overflow-y-auto rounded-md border border-darkborderc bg-darkbg/90 px-3 py-2 shadow-lg backdrop-blur-sm sm:right-auto sm:max-w-md">
                    {@render metadataOverlay()}
                </div>
            {/if}
        </div>
    </div>
    </OverlayPortal>
{/if}
