<script lang="ts">
  import { UserRoundIcon } from "@lucide/svelte";
  import { tooltipRight } from "src/ts/gui/tooltip";

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
    oncontextmenu,
    chaId
  }: Props = $props();

  const folderColorClasses: Record<string, { fill: string; border: string }> = {
    red: { fill: 'bg-draculared/20', border: 'border-draculared/40' },
    orange: { fill: 'bg-highlight/20', border: 'border-highlight/40' },
    yellow: { fill: 'bg-warning/20', border: 'border-warning/40' },
    green: { fill: 'bg-success/20', border: 'border-success/40' },
    blue: { fill: 'bg-primary/20', border: 'border-primary/40' },
    indigo: { fill: 'bg-accent/20', border: 'border-accent/40' },
    purple: { fill: 'bg-scoped/20', border: 'border-scoped/40' },
    // Keep folders saved with the former palette's pink option theme-aware.
    pink: { fill: 'bg-scoped/20', border: 'border-scoped/40' },
  };

  let folderColorStyle = $derived(folderColorClasses[color] ?? {
    fill: 'bg-darkbg/20',
    border: 'border-selected',
  });

  function handleContextMenu(e: MouseEvent & {
    currentTarget: EventTarget & HTMLDivElement;
  }) {
    e.preventDefault();
    oncontextmenu?.(e);
  }
</script>

<!-- svelte-ignore a11y_click_events_have_key_events -->
<span class="flex shrink-0 items-center justify-center avatar sidebar-touch-target {bordered ? folderColorStyle.border : ''}"
      class:border = {bordered}
      class:rounded-md={!rounded}
      class:rounded-full={rounded}
      oncontextmenu={handleContextMenu}
      onclick={onClick} use:tooltipRight={name}
      role="button"
      tabindex="0"
      data-char-id={chaId}
      data-selected={selected}
>
  {#if src}
    {#if src === "slot"}
      {#await backgroundimg}
        <div
        class="bg-skin-border sidebar-avatar sidebar-touch-target rounded-md bg-top flex items-center justify-center text-textcolor {folderColorStyle.fill}"
        style:width={size + "px"}
        style:height={size + "px"}
        style:min-width={size + "px"}
        class:rounded-md={!rounded} class:rounded-full={rounded}
      ></div>
      {:then resolvedBgImg}
      <div
        class="bg-skin-border sidebar-avatar sidebar-touch-target rounded-md bg-top flex items-center justify-center text-textcolor {folderColorStyle.fill}"
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
          class="sidebar-avatar rounded-md bg-top"
          style:width={size + "px"}
          style:height={size + "px"}
          style:min-width={size + "px"}
          class:rounded-md={!rounded} class:rounded-full={rounded} 
></div>
      {:then img}
        <img
          src={img}
          class="sidebar-avatar sidebar-touch-target rounded-md object-cover object-top"
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
      class="sidebar-avatar sidebar-touch-target rounded-md bg-darkbg flex items-center justify-center text-textcolor"
      style:width={size + "px"}
      style:height={size + "px"}
      style:min-width={size + "px"}
      class:rounded-md={!rounded} class:rounded-full={rounded} 
    >
      <UserRoundIcon size={Number(size) * 0.55} aria-hidden="true" />
    </div>
  {/if}
</span>

<style>
  .sidebar-touch-target {
    -webkit-touch-callout: none;
    -webkit-user-drag: none;
    user-select: none;
  }

  .avatar {
    position: relative;
    outline: 1px solid transparent;
    outline-offset: 0;
    transition: outline-color 150ms ease;
  }

  .avatar:hover {
    outline-color: color-mix(in srgb, var(--risu-theme-borderc) 50%, transparent);
  }

  .avatar:focus-visible,
  .avatar[data-selected="true"] {
    outline-color: var(--risu-theme-borderc);
  }

  .avatar[data-selected="true"]::after {
    content: "";
    position: absolute;
    inset: 0;
    border-radius: inherit;
    background: linear-gradient(
      to top,
      color-mix(in srgb, var(--risu-theme-borderc) 53%, transparent) 0%,
      color-mix(in srgb, var(--risu-theme-borderc) 28%, transparent) 20%,
      color-mix(in srgb, var(--risu-theme-borderc) 13%, transparent) 42%,
      transparent 75%
    );
    pointer-events: none;
  }
</style>
