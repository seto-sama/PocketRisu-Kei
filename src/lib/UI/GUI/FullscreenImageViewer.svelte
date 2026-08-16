<script lang="ts">
    import type { Snippet } from 'svelte';
    import { ChevronLeft, ChevronRight, Download, Info, X } from '@lucide/svelte';
    import Portal from './Portal.svelte';

    interface Props {
        open?: boolean;
        src?: string;
        alt?: string;
        title?: string;
        position?: number;
        total?: number;
        loading?: boolean;
        error?: string;
        loadingLabel?: string;
        canGoPrev?: boolean;
        canGoNext?: boolean;
        infoOpen?: boolean;
        infoLabel?: string;
        downloadLabel?: string;
        closeLabel?: string;
        previousLabel?: string;
        nextLabel?: string;
        onClose: () => void;
        onPrev?: () => void;
        onNext?: () => void;
        onDownload?: () => void | Promise<void>;
        viewerContent?: Snippet;
        info?: Snippet;
        statusOverlay?: Snippet;
    }

    let {
        open = false,
        src = '',
        alt = '',
        title = '',
        position = -1,
        total = 0,
        loading = false,
        error = '',
        loadingLabel = 'Loading...',
        canGoPrev = false,
        canGoNext = false,
        infoOpen = $bindable(false),
        infoLabel = 'Info',
        downloadLabel = 'Download',
        closeLabel = 'Close',
        previousLabel = 'Previous image',
        nextLabel = 'Next image',
        onClose,
        onPrev,
        onNext,
        onDownload,
        viewerContent,
        info,
        statusOverlay,
    }: Props = $props();

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
    <div class="fixed inset-0 z-50 flex overflow-hidden bg-bgcolor text-textcolor">
        <div class="relative flex flex-1 min-w-0 items-center justify-center overflow-hidden">
            <div class="absolute top-0 inset-x-0 z-10 flex items-center gap-3 px-4 py-3 bg-gradient-to-b from-darkbg/90 to-transparent pointer-events-none">
                <div class="flex-1 min-w-0">
                    <p class="text-textcolor text-sm font-semibold truncate">{title}</p>
                    {#if position >= 0 && total > 0}
                        <p class="text-textcolor2 text-xs">{position + 1} / {total}</p>
                    {/if}
                </div>
                <div class="flex gap-2 shrink-0 pointer-events-auto">
                    {#if info}
                        <button
                            type="button"
                            class="w-9 h-9 rounded-full border border-darkborderc bg-darkbutton risu-interactive-surface-solid flex items-center justify-center text-textcolor transition-colors"
                            onclick={() => (infoOpen = !infoOpen)}
                            title={infoLabel}
                        >
                            <Info size={16} />
                        </button>
                    {/if}
                    {#if onDownload}
                        <button
                            type="button"
                            class="w-9 h-9 rounded-full border border-darkborderc bg-darkbutton risu-interactive-surface-solid flex items-center justify-center text-textcolor transition-colors"
                            onclick={onDownload}
                            title={downloadLabel}
                        >
                            <Download size={16} />
                        </button>
                    {/if}
                    <button
                        type="button"
                        class="w-9 h-9 rounded-full border border-darkborderc bg-darkbutton risu-interactive-surface-solid flex items-center justify-center text-textcolor transition-colors"
                        onclick={onClose}
                        title={closeLabel}
                    >
                        <X size={16} />
                    </button>
                </div>
            </div>

            {#if canGoPrev}
                <button
                    type="button"
                    class="absolute left-3 z-10 w-11 h-11 rounded-full border border-darkborderc bg-darkbutton risu-interactive-surface-solid flex items-center justify-center text-textcolor transition-colors"
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
                    class="absolute right-3 z-10 w-11 h-11 rounded-full border border-darkborderc bg-darkbutton risu-interactive-surface-solid flex items-center justify-center text-textcolor transition-colors"
                    onclick={onNext}
                    aria-label={nextLabel}
                >
                    <ChevronRight size={20} class="translate-x-px" />
                </button>
            {/if}

            {#if statusOverlay}
                {@render statusOverlay()}
            {/if}
        </div>

        {#if infoOpen && info}
            <div class="w-72 xl:w-80 shrink-0 flex flex-col overflow-hidden border-l border-darkborderc bg-darkbg">
                <div class="flex items-center justify-between px-4 py-3">
                    <span class="text-textcolor text-sm font-semibold">{infoLabel}</span>
                    <button
                        type="button"
                        class="text-textcolor2 risu-interactive-foreground transition-colors"
                        onclick={() => (infoOpen = false)}
                        aria-label={closeLabel}
                    >
                        <X size={16} />
                    </button>
                </div>
                <div class="flex-1 overflow-y-auto">
                    {@render info()}
                </div>
            </div>
        {/if}
    </div>
    </Portal>
{/if}
