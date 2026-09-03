<!-- TODO: REMOVE AND REFACTOR TO BASE BUTTON UI COMPONENT -->

<script lang="ts">
  import AvatarFallback from "../UI/AvatarFallback.svelte";

  interface Props {
    onClick?: any;
    additionalStyle?: string | Promise<string>;
    interactive?: boolean;
    children?: import('svelte').Snippet;
  }

  let { onClick = () => {}, additionalStyle = "", interactive = true, children }: Props = $props();
</script>

{#await additionalStyle}
  {#if interactive}
    <button type="button" onclick={onClick} class="ico">{@render children?.()}</button>
  {:else}
    <div class="ico noninteractive">{@render children?.()}</div>
  {/if}
{:then as}
  {#if interactive}
    <button type="button" onclick={onClick} class="ico" style={as}>
      {#if as || children}{@render children?.()}{:else}<AvatarFallback className="h-full w-full rounded-md" iconSize={30} />{/if}
    </button>
  {:else}
    <div class="ico noninteractive" style={as}>
      {#if as || children}{@render children?.()}{:else}<AvatarFallback className="h-full w-full rounded-md" iconSize={30} />{/if}
    </div>
  {/if}
{/await}

<style>
  .ico {
    cursor: pointer;
    border-radius: 0.375rem;
    height: 3.5rem;
    width: 3.5rem;
    min-height: 3.5rem;
    --tw-shadow-color: 0, 0, 0;
    --tw-shadow: 0 10px 15px -3px rgba(var(--tw-shadow-color), 0.1),
      0 4px 6px -2px rgba(var(--tw-shadow-color), 0.05);
    -webkit-box-shadow: var(--tw-ring-offset-shadow, 0 0 transparent),
      var(--tw-ring-shadow, 0 0 transparent), var(--tw-shadow);
    box-shadow: var(--tw-ring-offset-shadow, 0 0 transparent),
      var(--tw-ring-shadow, 0 0 transparent), var(--tw-shadow);
    background-color: var(--risu-theme-button);
    color: var(--risu-theme-maintext);
    display: flex;
    justify-content: center;
    align-items: center;
    transition-property: background-color, border-color, color, fill, stroke;
    transition-duration: 150ms;
    transition-timing-function: cubic-bezier(0.4, 0, 0.2, 1);
  }

  .ico:not(.noninteractive):is(:hover, :focus-visible) {
    background-color: var(--risu-theme-lightborderc);
  }

  .ico.noninteractive {
    cursor: default;
  }
</style>
