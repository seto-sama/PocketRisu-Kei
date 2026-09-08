<script lang="ts">
    import { ArrowLeftIcon, ArrowRightIcon } from "@lucide/svelte";
    import { DynamicGUI, sideBarClosing, sideBarStore } from "src/ts/stores.svelte";

</script>

{#if $sideBarStore && !$DynamicGUI}
    <button onclick={() => {sideBarClosing.set(true)}} class="risu-layer-composer absolute top-3 left-0 h-12 w-12 border-r border-b border-t border-darkborderc rounded-r-md bg-darkbg risu-interactive-border transition-colors flex items-center justify-center text-maintext">
        <ArrowLeftIcon />
    </button>
{:else}
    <button onclick={() => {
        sideBarClosing.set(false);
        sideBarStore.set(true)}} class="risu-layer-composer absolute top-3 left-0 h-12 w-12 border-r border-b border-t border-darkborderc rounded-r-md bg-darkbg risu-interactive-border transition-colors flex items-center justify-center text-maintext opacity-50 hover:opacity-90">
        <ArrowRightIcon />
    </button>
{/if}
