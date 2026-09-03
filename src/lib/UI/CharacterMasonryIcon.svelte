<script lang="ts">
    import { UserRoundIcon } from "@lucide/svelte";
    import { tooltip } from "src/ts/gui/tooltip";
    import SelectionParticles from "./SelectionParticles.svelte";

    interface Props {
        src?: string | Promise<string>;
        name: string;
        selected?: boolean;
        hideImage?: boolean;
        onclick?: () => void;
    }

    let {
        src = '',
        name,
        selected = false,
        hideImage = false,
        onclick = () => {},
    }: Props = $props();

    let deferredSrc = $state('');
    let deferredReady = $state(false);

    $effect(() => {
        const source = src;
        if (hideImage || !source) {
            deferredSrc = '';
            deferredReady = false;
            return;
        }

        let active = true;
        deferredSrc = '';
        deferredReady = false;

        Promise.resolve(source).then((resolvedSrc) => {
            if (!active) return;
            const image = new Image();
            image.decoding = 'async';
            image.onload = () => {
                if (!active) return;
                deferredSrc = resolvedSrc;
                deferredReady = true;
            };
            image.src = resolvedSrc;
        }).catch(() => {});

        return () => {
            active = false;
        };
    });
</script>

{#if hideImage || !src || deferredReady}
<button
    type="button"
    class="relative block w-full overflow-hidden rounded-md border bg-darkbg text-textcolor transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/70 {selected ? 'border-primary' : 'border-darkborderc hover:border-primary/60'} {hideImage || !src ? 'aspect-square' : ''}"
    aria-label={name}
    aria-pressed={selected || undefined}
    use:tooltip={name}
    {onclick}
>
    {#if hideImage || !src}
        <span class="flex h-full w-full items-center justify-center bg-darkbutton text-textcolor2">
            {#if hideImage}
                <span class="text-4xl">?</span>
            {:else}
                <UserRoundIcon class="h-2/5 w-2/5" aria-hidden="true" />
            {/if}
        </span>
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
</button>
{/if}
