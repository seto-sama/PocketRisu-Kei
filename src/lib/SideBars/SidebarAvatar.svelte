<script lang="ts">
  import { getFolderColorStyle } from "./folderColors";
  import SelectionParticles from "../UI/SelectionParticles.svelte";
  import AvatarFallback from "../UI/AvatarFallback.svelte";
  import Tooltip from "../UI/components/Tooltip.svelte";

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
    interactive?: boolean;
    showTooltip?: boolean;
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
    interactive = true,
    showTooltip = true,
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
<!-- svelte-ignore a11y_no_noninteractive_tabindex: role and tabindex are both omitted for noninteractive avatar reuse -->
<Tooltip side="right" variant="glass" disabled={!showTooltip || !name.trim()}>
  {#snippet trigger(props)}
  <span {...props} class="flex shrink-0 items-center justify-center avatar avatar-state-border sidebar-touch-target"
      style:--risu-folder-color={folderColorStyle.accent}
      class:rounded-md={!rounded}
      class:rounded-full={rounded}
      oncontextmenu={interactive ? handleContextMenu : undefined}
      onclick={interactive ? onClick : undefined}
      role={interactive ? "button" : undefined}
      tabindex={interactive ? 0 : undefined}
      data-char-id={chaId}
      data-selected={selected}
      data-merge-target={mergeTarget}
>
  {#if src}
    {#if src === "slot"}
      {#await backgroundimg}
        <div
        class="bg-skin-border sidebar-avatar avatar-tile folder-avatar-tile sidebar-touch-target rounded-md bg-top flex items-center justify-center text-maintext {folderColorStyle.fill}"
        style:width={size + "px"}
        style:height={size + "px"}
        style:min-width={size + "px"}
        class:rounded-md={!rounded} class:rounded-full={rounded}
      ></div>
      {:then resolvedBgImg}
      <div
        class="bg-skin-border sidebar-avatar avatar-tile folder-avatar-tile sidebar-touch-target rounded-md bg-top flex items-center justify-center text-maintext {folderColorStyle.fill}"
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
      class="sidebar-avatar avatar-tile sidebar-touch-target rounded-md"
      style:width={size + "px"}
      style:height={size + "px"}
      style:min-width={size + "px"}
      class:rounded-md={!rounded} class:rounded-full={rounded} 
    >
      <AvatarFallback
        className="h-full w-full {rounded ? 'rounded-full' : 'rounded-md'}"
        iconSize={Number(size) * 0.55}
      />
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
  {/snippet}
  {name}
</Tooltip>

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
