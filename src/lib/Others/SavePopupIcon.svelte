<script lang="ts">
  import { SaveIcon } from "@lucide/svelte";
  import { saving } from "src/ts/globalApi.svelte";
  import { DBState } from "src/ts/stores.svelte";

</script>

{#if DBState?.db?.showSavingIcon && saving.state}
  <div
    class="absolute top-3 right-3 z-10 text-white p-2 rounded-sm bg-linear-to-br risu-saving-gradient saving-animation pointer-events-none opacity-15"
  >
    <SaveIcon size={20} />
  </div>
{/if}
