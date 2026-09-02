<script lang="ts">
  import {
    SearchIcon,
    StarIcon,
    SettingsIcon,
    MoreVerticalIcon,
    BarChartIcon,
    Trash2Icon,
    XIcon,
    StickyNotePlusIcon,
    TagIcon,
  } from "@lucide/svelte";
  import { language } from "src/lang";
  import {
    hypaV3ModalOpen,
  } from "src/ts/stores.svelte";
  import { openSettings, SettingsRoute } from "src/ts/routing";
  import type { SearchState } from "./types";
  import IconButton from "src/lib/UI/GUI/IconButton.svelte";
  import IconButtonGroup from "src/lib/UI/GUI/IconButtonGroup.svelte";
  import ShDropdownMenu from "src/lib/UI/GUI/ShDropdownMenu.svelte";
  import ShDropdownMenuContent from "src/lib/UI/GUI/ShDropdownMenuContent.svelte";
  import ShDropdownMenuItem from "src/lib/UI/GUI/ShDropdownMenuItem.svelte";
  import ShDropdownMenuTrigger from "src/lib/UI/GUI/ShDropdownMenuTrigger.svelte";
  import { handleDualAction } from "./utils";

  interface Props {
    searchState: SearchState;
    showImportantOnly: boolean;
    manualSummaryMode: boolean;
    resummaryMode: boolean;
    filterSelected: boolean;
    onToggleImportant: () => void;
    onToggleFilterSelected: () => void;
    onResetData: () => Promise<void>;
    onToggleManualSummaryMode: () => void;
    onToggleResummaryMode: () => void;
    onOpenCategoryManager: () => void;
  }

  let {
    searchState = $bindable(),
    showImportantOnly,
    manualSummaryMode,
    resummaryMode,
    filterSelected,
    onToggleImportant,
    onToggleFilterSelected,
    onResetData,
    onToggleManualSummaryMode,
    onToggleResummaryMode,
    onOpenCategoryManager,
  }: Props = $props();


  function toggleSearch() {
    if (searchState === null) {
      searchState = {
        query: "",
        results: [],
        currentResultIndex: -1,
        requestedSearchFromIndex: -1,
        isNavigating: false,
      };
    } else {
      searchState = null;
    }
  }

  function openGlobalSettings() {
    $hypaV3ModalOpen = false;
    openSettings(SettingsRoute.OtherBots);
  }

  async function resetData() {
    await onResetData();
  }

  function closeModal() {
    $hypaV3ModalOpen = false;
  }

</script>

<div class="flex min-w-0 items-center justify-between gap-1 mb-2 sm:mb-4">
  <!-- Modal Title -->
  <h1 class="min-w-0 truncate text-lg font-semibold text-maintext sm:text-2xl">
    {language.hypaV3Modal.titleLabel}
  </h1>

  <!-- Buttons Container -->
  <IconButtonGroup size="lg" className="shrink-0 gap-0 sm:gap-2">
    <!-- Open Search Button -->
    <IconButton
      tabindex={-1}
      onclick={toggleSearch}
    >
      <SearchIcon />
    </IconButton>

    <!-- Category Manager / Category Filter Button -->
    <IconButton
      className="header-category-action"
      tabindex={-1}
      onclick={onOpenCategoryManager}
    >
      <TagIcon />
    </IconButton>

    <!-- Filter Important Summary Button -->
    <IconButton
      active={showImportantOnly}
      tabindex={-1}
      onclick={onToggleImportant}
    >
      <StarIcon />
    </IconButton>

    <!-- Left click: manual summary. Right click / alternate action: re-summary. -->
    <span
      class="inline-flex"
      use:handleDualAction={{
        onMainAction: onToggleManualSummaryMode,
        onAlternativeAction: onToggleResummaryMode,
      }}
    >
      <IconButton
        active={manualSummaryMode || resummaryMode}
        activeColor="primary"
        tabindex={-1}
        title={language.hypaV3Modal.manualSummarize}
        oncontextmenu={(event) => {
          event.preventDefault();
          onToggleResummaryMode();
        }}
      >
        <StickyNotePlusIcon />
      </IconButton>
    </span>

    <!-- Open Global Settings Button -->
    <IconButton
      className="header-settings-action"
      tabindex={-1}
      onclick={openGlobalSettings}
    >
      <SettingsIcon />
    </IconButton>

    <!-- Open Dropdown Button -->
    <div class="flex h-[var(--icon-cell-size)] items-center leading-none">
      <ShDropdownMenu>
        <ShDropdownMenuTrigger>
          {#snippet child({ props })}
            <IconButton {...props} size="lg" tabindex={-1}>
              <MoreVerticalIcon />
            </IconButton>
          {/snippet}
        </ShDropdownMenuTrigger>
        <ShDropdownMenuContent align="end" class="min-w-44">
        <ShDropdownMenuItem class="dropdown-category-action" onSelect={onOpenCategoryManager}>
          <TagIcon />
          {language.hypaV3Modal.categoryManager}
        </ShDropdownMenuItem>
        <ShDropdownMenuItem class="dropdown-settings-action" onSelect={openGlobalSettings}>
          <SettingsIcon />
          {language.settings}
        </ShDropdownMenuItem>
        <ShDropdownMenuItem onSelect={onToggleFilterSelected}>
          <BarChartIcon class={filterSelected ? "text-primary" : ""} />
          {language.hypaV3Modal.filterMetrics}
        </ShDropdownMenuItem>
        <ShDropdownMenuItem variant="destructive" onSelect={resetData}>
          <Trash2Icon />
          {language.reset}
        </ShDropdownMenuItem>
        </ShDropdownMenuContent>
      </ShDropdownMenu>
    </div>

    <!-- Close Modal Button -->
    <IconButton
      tabindex={-1}
      onclick={closeModal}
    >
      <XIcon />
    </IconButton>
  </IconButtonGroup>
</div>

<style>
  :global(.header-category-action),
  :global(.header-settings-action) {
    display: none;
  }

  @media (min-width: 520px) {
    :global(.header-category-action) {
      display: inline-flex;
    }

    :global(.dropdown-category-action) {
      display: none;
    }
  }

  @media (min-width: 640px) {
    :global(.header-settings-action) {
      display: inline-flex;
    }

    :global(.dropdown-settings-action) {
      display: none;
    }
  }
</style>
