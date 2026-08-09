<script lang="ts">
    import { PRODUCT_BASE_NAME, PRODUCT_NAME } from 'src/ts/branding';
    import KeiSticker from './KeiSticker.svelte';
</script>

<h2
    class="relative mb-0 mt-6 text-4xl font-black text-textcolor"
    aria-label={PRODUCT_NAME}
>
    <span class="inline-flex items-center whitespace-nowrap">
        {PRODUCT_BASE_NAME}<KeiSticker />
    </span>
</h2>
