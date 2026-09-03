<script lang="ts">
  import { UserRoundIcon } from "@lucide/svelte";
  import { tooltipRight } from "src/ts/gui/tooltip";
  import { getFolderColorStyle } from "./folderColors";
  import SelectionParticles from "../UI/SelectionParticles.svelte";

  interface Props {
    rounded: boolean;
    src: string|Promise<string>;
    name: string;
    size?: string;
    onClick?: any;
    bordered?: boolean;
    color?: string;
    backgroundimg?: string|Promise<string>;
    children?: import('svelte').Snippet;
    selected?: boolean;
    mergeTarget?: boolean;
    oncontextmenu?: (event: MouseEvent & {
        currentTarget: EventTarget & HTMLDivElement;
    }) => any
    chaId?: string;
  }

  let {
    rounded,
    src,
    name,
    size = "22",
    onClick = () => {},
    bordered = false,
    color = '',
    backgroundimg = '',
    children,
    selected = false,
    mergeTarget = false,
    oncontextmenu,
    chaId
  }: Props = $props();

  let folderColorStyle = $derived(getFolderColorStyle(color));
  let hasFolderImage = $derived(bordered && Boolean(backgroundimg));
  let showFolderBorder = $derived(bordered && !hasFolderImage);

  function handleContextMenu(e: MouseEvent & {
    currentTarget: EventTarget & HTMLDivElement;
  }) {
    e.preventDefault();
    oncontextmenu?.(e);
  }
</script>

<!-- svelte-ignore a11y_click_events_have_key_events -->
<span class="flex shrink-0 items-center justify-center avatar avatar-state-border sidebar-touch-target"
      class:rounded-md={!rounded}
      class:rounded-full={rounded}
      oncontextmenu={handleContextMenu}
      onclick={onClick} use:tooltipRight={name}
      role="button"
      tabindex="0"
      data-char-id={chaId}
      data-selected={selected}
      data-merge-target={mergeTarget}
>
  {#if src}
    {#if src === "slot"}
      {#await backgroundimg}
        <div
        class="bg-skin-border sidebar-avatar avatar-tile folder-avatar-tile sidebar-touch-target rounded-md bg-top flex items-center justify-center text-textcolor {folderColorStyle.fill}"
        style:width={size + "px"}
        style:height={size + "px"}
        style:min-width={size + "px"}
        class:rounded-md={!rounded} class:rounded-full={rounded}
      ></div>
      {:then resolvedBgImg}
      <div
        class="bg-skin-border sidebar-avatar avatar-tile folder-avatar-tile sidebar-touch-target rounded-md bg-top flex items-center justify-center text-textcolor {folderColorStyle.fill}"
        style:width={size + "px"}
        style:height={size + "px"}
        style:min-width={size + "px"}
        style:background-image={resolvedBgImg ? `url('${resolvedBgImg}')` : undefined}
        style:background-size={resolvedBgImg ? "cover" : undefined}
        style:background-position={resolvedBgImg ? "center" : undefined}
        class:rounded-md={!rounded} class:rounded-full={rounded}
      >
      {#if !resolvedBgImg}
        {@render children?.()}
      {/if}
        </div>
    {/await}
    {:else}
      {#await src}
        <div
          class="sidebar-avatar avatar-tile rounded-md bg-top"
          style:width={size + "px"}
          style:height={size + "px"}
          style:min-width={size + "px"}
          class:rounded-md={!rounded} class:rounded-full={rounded} 
></div>
      {:then img}
        <img
          src={img}
          class="sidebar-avatar avatar-tile sidebar-touch-target rounded-md object-cover object-top"
          style:width={size + "px"}
          style:height={size + "px"}
          style:min-width={size + "px"}
          class:rounded-md={!rounded} class:rounded-full={rounded} 
          alt="avatar"
        />
      {/await}
    {/if}
  {:else}
    <div
      class="sidebar-avatar avatar-tile sidebar-touch-target rounded-md bg-darkbg flex items-center justify-center text-textcolor"
      style:width={size + "px"}
      style:height={size + "px"}
      style:min-width={size + "px"}
      class:rounded-md={!rounded} class:rounded-full={rounded} 
    >
      <UserRoundIcon size={Number(size) * 0.55} aria-hidden="true" />
    </div>
  {/if}
  {#if selected}
    <SelectionParticles rise={`-${Math.max(28, Number(size) - 6)}px`} />
  {/if}
  <span
    class="avatar-border-overlay box-border border {showFolderBorder ? folderColorStyle.border : 'border-transparent'}"
    aria-hidden="true"
  ></span>
</span>

<style>
  .sidebar-touch-target {
    -webkit-touch-callout: none;
    -webkit-user-drag: none;
    user-select: none;
  }

  .avatar {
    position: relative;
  }

  .avatar-border-overlay {
    position: absolute;
    inset: 0;
    z-index: 2;
    border-radius: inherit;
    pointer-events: none;
    transition: border-color 150ms ease;
  }

  .avatar-state-border:is(:hover, :focus-visible) > .avatar-border-overlay {
    border-color: color-mix(in srgb, var(--risu-theme-primary) 50%, transparent);
  }

  .avatar-state-border[data-selected="true"] > .avatar-border-overlay {
    border-color: var(--risu-theme-primary);
  }

  .avatar-state-border[data-merge-target="true"] > .avatar-border-overlay {
    border-color: color-mix(in srgb, var(--risu-theme-primary) 82%, white);
    background: color-mix(in srgb, var(--risu-theme-primary) 7%, transparent);
    box-shadow:
      inset 0 0 0 1px color-mix(in srgb, var(--risu-theme-primary) 32%, transparent),
      0 0 10px color-mix(in srgb, var(--risu-theme-primary) 30%, transparent);
  }

</style>
