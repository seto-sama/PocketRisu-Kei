<script lang="ts">
    import SelectionParticles from "./SelectionParticles.svelte";
    import { ImageOffIcon } from "@lucide/svelte";
    import AvatarFallback from "./AvatarFallback.svelte";

    interface Props {
        src?: string | Promise<string>;
        name: string;
        subtitle?: string;
        selected?: boolean;
        /** The character has an image that is hidden. A src is then only loaded for its ratio. */
        hideImage?: boolean;
        onclick?: () => void;
    }

    let {
        src = '',
        name,
        subtitle = '',
        selected = false,
        hideImage = false,
        onclick = () => {},
    }: Props = $props();

    let deferredSrc = $state('');
    let deferredRatio = $state('');
    let deferredReady = $derived(Boolean(deferredSrc));
    let deferredFailed = $state(false);

    $effect(() => {
        const source = src;
        deferredSrc = '';
        deferredRatio = '';
        deferredFailed = false;
        if (!source) {
            return;
        }

        let active = true;
        let image: HTMLImageElement | null = null;

        // Hidden images still load off screen, so their placeholder keeps the
        // image's ratio and the masonry layout does not change shape.
        Promise.resolve(source).then((resolvedSrc) => {
            if (!active) return;
            if (!resolvedSrc) {
                deferredFailed = true;
                return;
            }
            image = new Image();
            image.decoding = 'async';
            image.onload = () => {
                if (!active || !image) return;
                deferredSrc = resolvedSrc;
                deferredRatio = `${image.naturalWidth} / ${image.naturalHeight}`;
            };
            image.onerror = () => {
                if (!active) return;
                deferredFailed = true;
            };
            image.src = resolvedSrc;
        }).catch(() => {
            if (!active) return;
            deferredFailed = true;
        });

        return () => {
            active = false;
            if (image) {
                image.onload = null;
                image.onerror = null;
            }
        };
    });
</script>

{#if !src || deferredReady || deferredFailed}
<button
    type="button"
    class="group relative block w-full overflow-hidden rounded-md border bg-darkbg text-maintext transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/70 {selected ? 'border-primary' : 'border-darkborderc hover:border-primary/50'} {deferredReady ? '' : 'aspect-square'}"
    style:aspect-ratio={hideImage && deferredReady ? deferredRatio : undefined}
    aria-label={name}
    aria-pressed={selected || undefined}
    {onclick}
>
    {#if hideImage}
        <span class="flex h-full w-full items-center justify-center bg-button text-subtext">
            <ImageOffIcon class="h-auto w-2/5" strokeWidth={1.5} aria-hidden="true" />
        </span>
    {:else if !deferredReady}
        <AvatarFallback className="h-full w-full" iconClass="h-2/5 w-2/5" strokeWidth={1.5} />
    {:else}
        <img
            class="block h-auto w-full object-cover object-top"
            src={deferredSrc}
            alt={name}
        />
    {/if}
    {#if selected}
        <SelectionParticles />
    {/if}
    <span
        class="pointer-events-none absolute inset-x-0 bottom-0 flex flex-col bg-gradient-to-t from-themeblack from-[-25%] to-transparent px-2 pb-2 pt-8 text-left opacity-0 transition-opacity duration-150 group-hover:opacity-100 group-focus-visible:opacity-100"
    >
        <span class="truncate text-xs font-medium leading-tight text-themewhite">{name}</span>
        {#if subtitle}
            <span class="truncate text-[10px] leading-tight text-themewhite/50">{subtitle}</span>
        {/if}
    </span>
</button>
{/if}
