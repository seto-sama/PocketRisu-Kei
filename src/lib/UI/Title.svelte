<script lang="ts">
    import { PRODUCT_BASE_NAME, PRODUCT_NAME } from 'src/ts/branding';
    import KeiSticker from './KeiSticker.svelte';
</script>

<h2
    class="relative mb-0 mt-6 w-fit text-4xl font-black text-maintext"
    aria-label={PRODUCT_NAME}
>
    <span class="whitespace-nowrap">{PRODUCT_BASE_NAME}</span>
    <span class="absolute left-full top-1/2 inline-flex -translate-y-1/2">
        <KeiSticker />
    </span>
</h2>
