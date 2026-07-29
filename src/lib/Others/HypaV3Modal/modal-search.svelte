<script lang="ts">
  import { ChevronDownIcon, ChevronUpIcon } from "@lucide/svelte";
  import { language } from "src/lang";
  import IconButton from "src/lib/UI/GUI/IconButton.svelte";
  import IconButtonGroup from "src/lib/UI/GUI/IconButtonGroup.svelte";
  import ShInput from "src/lib/UI/GUI/ShInput.svelte";
  import type { SearchSession } from "./types";

  interface Props {
    searchState: SearchSession;
    onSearch: (event: KeyboardEvent) => void;
  }

  let { searchState, onSearch }: Props = $props();

  function resetResults() {
    searchState.results = [];
    searchState.currentResultIndex = -1;
  }

  function navigate(backward = false) {
    onSearch({ key: "Enter", shiftKey: backward } as KeyboardEvent);
  }
</script>

<div class="mb-2 flex items-center gap-2 sm:mb-4">
    <div class="relative flex flex-1 items-center">
      <form
        class="w-full"
        onsubmit={(event) => {
          event.preventDefault();
          navigate();
        }}
      >
        <ShInput
          className="bg-darkbg! pr-20"
          placeholder={language.hypaV3Modal.searchPlaceholder}
          bind:value={searchState.query}
          oninput={resetResults}
          onkeydown={onSearch}
        />
      </form>

      {#if searchState.results.length > 0}
        <span class="absolute right-2 top-1/2 -translate-y-1/2 rounded-md bg-selected/60 px-2 py-1 text-xs font-medium text-textcolor">
          {searchState.currentResultIndex + 1}/{searchState.results.length}
        </span>
      {/if}
    </div>

    <IconButtonGroup>
      <IconButton
        tabindex={-1}
        aria-label="Previous result"
        onclick={() => navigate(true)}
      >
        <ChevronUpIcon />
      </IconButton>
      <IconButton
        tabindex={-1}
        aria-label="Next result"
        onclick={() => navigate()}
      >
        <ChevronDownIcon />
      </IconButton>
    </IconButtonGroup>
</div>
