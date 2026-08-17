<script lang="ts">
  import { UserRoundIcon } from "@lucide/svelte";
  import { tooltipRight } from "src/ts/gui/tooltip";
  import { getFolderColorStyle } from "./folderColors";

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

  interface SelectionParticle {
    id: number;
    x: string;
    size: string;
    duration: string;
  }

  let selectionParticles = $state<SelectionParticle[]>([]);
  let nextParticleId = 0;
  const particleMap = new Map<number, SelectionParticle>();

  function randomBetween(min: number, max: number) {
    return min + Math.random() * (max - min);
  }

  $effect(() => {
    particleMap.clear();
    selectionParticles = [];
    if (!selected || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

    let spawnTimer: ReturnType<typeof setTimeout> | undefined;
    const removalTimers = new Set<ReturnType<typeof setTimeout>>();

    const spawnParticle = () => {
      const durationSeconds = randomBetween(1.75, 2.45);
      const particle: SelectionParticle = {
        id: nextParticleId++,
        x: `${randomBetween(7, 93).toFixed(1)}%`,
        size: `${randomBetween(1, 2.5).toFixed(2)}px`,
        duration: `${durationSeconds.toFixed(2)}s`,
      };

      particleMap.set(particle.id, particle);
      selectionParticles = [...particleMap.values()];

      const removalTimer = setTimeout(() => {
        particleMap.delete(particle.id);
        removalTimers.delete(removalTimer);
        selectionParticles = [...particleMap.values()];
      }, durationSeconds * 1000 + 100);
      removalTimers.add(removalTimer);

      spawnTimer = setTimeout(spawnParticle, randomBetween(180, 420));
    };

    spawnParticle();

    return () => {
      if (spawnTimer) clearTimeout(spawnTimer);
      removalTimers.forEach(clearTimeout);
      particleMap.clear();
      selectionParticles = [];
    };
  });

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
    <span
      class="avatar-selection-particles"
      style={`--particle-rise: -${Math.max(28, Number(size) - 6)}px`}
      aria-hidden="true"
    >
      {#each selectionParticles as particle}
        <span
          class="avatar-selection-particle"
          style={`--x: ${particle.x}; --size: ${particle.size}; --duration: ${particle.duration};`}
        ></span>
      {/each}
    </span>
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

  .avatar[data-selected="true"]::after {
    content: "";
    position: absolute;
    inset: 0;
    border-radius: inherit;
    z-index: 1;
    background: linear-gradient(
      to top,
      color-mix(in srgb, var(--risu-theme-primary) 53%, transparent) 0%,
      color-mix(in srgb, var(--risu-theme-primary) 28%, transparent) 20%,
      color-mix(in srgb, var(--risu-theme-primary) 13%, transparent) 42%,
      transparent 75%
    );
    pointer-events: none;
  }

  .avatar-selection-particles {
    position: absolute;
    inset: 2px;
    z-index: 3;
    overflow: hidden;
    border-radius: inherit;
    mix-blend-mode: plus-lighter;
    pointer-events: none;
  }

  .avatar-selection-particle {
    position: absolute;
    bottom: 1px;
    left: var(--x);
    width: var(--size);
    height: var(--size);
    border-radius: 9999px;
    background: color-mix(in srgb, var(--risu-theme-primary) 72%, white);
    box-shadow:
      0 0 2px color-mix(in srgb, var(--risu-theme-primary) 85%, white),
      0 0 5px var(--risu-theme-primary);
    opacity: 0;
    animation: avatar-particle-rise var(--duration) cubic-bezier(0, 0, 0.45, 1) forwards;
    will-change: transform, opacity;
  }

  @keyframes avatar-particle-rise {
    0% {
      opacity: 0;
      transform: translate3d(0, 3px, 0) scale(0.65);
    }
    14% {
      opacity: 0.9;
    }
    45% {
      opacity: 0.76;
    }
    70% {
      opacity: 0.46;
    }
    88% {
      opacity: 0.16;
    }
    100% {
      opacity: 0;
      transform: translate3d(0, var(--particle-rise), 0) scale(0.35);
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .avatar-selection-particles {
      display: none;
    }
  }
</style>
