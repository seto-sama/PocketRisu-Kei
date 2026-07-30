<script lang="ts">
  interface Props {
    isDisabled?: boolean;
    rounded?: boolean;
    onClick: () => void;
    children?: import('svelte').Snippet;
  }

  let { isDisabled = false, rounded = false, onClick, children }: Props = $props();
</script>

<button
  disabled={isDisabled}
  onclick={onClick}
  class="flex h-[56px] w-[56px] cursor-pointer select-none items-center justify-center
   border border-dashed border-darkborderc bg-transparent
   text-textcolor2 opacity-75 transition-[background-color,opacity]
   hover:bg-selected/30 hover:opacity-100
   focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-borderc/50
   {isDisabled ? 'cursor-not-allowed!' : ''}"
  class:rounded-md={!rounded}
  class:rounded-full={rounded}
>
  {@render children?.()}
</button>
