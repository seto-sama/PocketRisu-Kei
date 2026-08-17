<script lang="ts">
    import type { Snippet } from 'svelte';
    import { ChevronLeft, ChevronRight, Info, X } from '@lucide/svelte';
    import Portal from './Portal.svelte';
    import IconButton from './IconButton.svelte';
    import IconButtonGroup from './IconButtonGroup.svelte';

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
        viewerContent,
        actions,
        metadataOverlay,
    }: Props = $props();
    let metadataOpen = $state(true);

    function handleKeydown(event: KeyboardEvent) {
        if(!open){
            return
        }
        if(event.key === 'ArrowLeft' && canGoPrev){
            event.preventDefault()
            onPrev?.()
        }
        else if(event.key === 'ArrowRight' && canGoNext){
            event.preventDefault()
            onNext?.()
        }
        else if(event.key === 'Escape'){
            event.preventDefault()
            onClose()
        }
    }
</script>

<svelte:window onkeydown={handleKeydown} />

{#if open}
    <Portal>
    <!-- Base tier keeps blocking alerts such as delete confirmation above the viewer. -->
    <div class="fixed inset-0 z-40 flex overflow-hidden bg-bgcolor text-textcolor">
        <div class="relative flex flex-1 min-w-0 items-center justify-center overflow-hidden">
            <div class="absolute top-0 inset-x-0 z-10 flex items-center gap-3 px-4 py-3 bg-gradient-to-b from-darkbg/90 to-transparent pointer-events-none">
                <div class="flex-1 min-w-0">
                    <p class="text-textcolor text-sm font-semibold truncate">{title}</p>
                    {#if subtitle || (position >= 0 && total > 0)}
                        <p class="flex min-w-0 items-center gap-2 text-textcolor2 text-xs">
                            {#if subtitle}<span class="truncate">{subtitle}</span>{/if}
                            {#if subtitle && position >= 0 && total > 0}<span class="h-3 w-px shrink-0 bg-textcolor2/40"></span>{/if}
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
                            className="text-textcolor"
                        >
                            <Info />
                        </IconButton>
                    {/if}
                    {#if actions}
                        {@render actions()}
                    {/if}
                    <IconButton
                        onclick={onClose}
                        title={closeLabel}
                        aria-label={closeLabel}
                        className="text-textcolor"
                    >
                        <X />
                    </IconButton>
                </IconButtonGroup>
            </div>

            {#if canGoPrev}
                <button
                    type="button"
                    class="absolute left-3 z-10 w-11 h-11 rounded-md bg-transparent risu-interactive-surface flex items-center justify-center text-textcolor transition-colors"
                    onclick={onPrev}
                    aria-label={previousLabel}
                >
                    <ChevronLeft size={20} class="-translate-x-px" />
                </button>
            {/if}

            <div
                class="w-full h-full flex items-center justify-center px-16 py-14"
            >
                {#if loading}
                    <div class="flex flex-col items-center gap-4">
                        <div class="w-12 h-12 border-4 border-selected border-t-primary rounded-full animate-spin"></div>
                        <p class="text-textcolor2 text-sm">{loadingLabel}</p>
                    </div>
                {:else if error}
                    <p class="text-draculared text-sm">{error}</p>
                {:else if viewerContent}
                    {@render viewerContent()}
                {:else if src}
                    <img
                        {src}
                        {alt}
                        class="max-w-full max-h-full object-contain rounded shadow-2xl"
                        style="max-height: calc(100vh - 112px);"
                    />
                {/if}
            </div>

            {#if canGoNext}
                <button
                    type="button"
                    class="absolute right-3 z-10 w-11 h-11 rounded-md bg-transparent risu-interactive-surface flex items-center justify-center text-textcolor transition-colors"
                    onclick={onNext}
                    aria-label={nextLabel}
                >
                    <ChevronRight size={20} class="translate-x-px" />
                </button>
            {/if}

            {#if metadataOpen && metadataOverlay}
                <div class="absolute bottom-3 left-3 right-3 z-10 max-h-[42vh] overflow-y-auto rounded-md border border-darkborderc bg-darkbg/90 px-3 py-2 shadow-lg backdrop-blur-sm sm:right-auto sm:max-w-md">
                    {@render metadataOverlay()}
                </div>
            {/if}
        </div>
    </div>
    </Portal>
{/if}
