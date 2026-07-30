<script lang="ts">
  import { StarIcon } from "@lucide/svelte";
  import type { BulkEditState, Category } from "./types";
  import { language } from "src/lang";
  import ShSelect from "src/lib/UI/GUI/ShSelect.svelte";
  import OptionInput from "src/lib/UI/GUI/OptionInput.svelte";
  import ShButton from "src/lib/UI/GUI/ShButton.svelte";
  import ShInput from "src/lib/UI/GUI/ShInput.svelte";
  import IconButton from "src/lib/UI/GUI/IconButton.svelte";

  interface Props {
    bulkEditState: BulkEditState;
    categories: Category[];
    onResummarize: () => void;
    onClearSelection: () => void;
    onUpdateSelectedCategory: (categoryId: string) => void;
    onUpdateBulkSelectInput: (input: string) => void;
    onApplyCategory: () => void;
    onToggleImportant: () => void;
    onParseAndSelectSummaries: () => void;
  }

  let {
    bulkEditState,
    categories,
    onResummarize,
    onClearSelection,
    onUpdateSelectedCategory,
    onUpdateBulkSelectInput,
    onApplyCategory,
    onToggleImportant,
    onParseAndSelectSummaries,
  }: Props = $props();

  function applyCategoryToSelected() {
    onApplyCategory();
  }

  function bulkToggleImportant() {
    onToggleImportant();
  }

  function parseAndSelectSummaries() {
    onParseAndSelectSummaries();
  }

  function clearSelection() {
    onClearSelection();
  }

  function handleCategoryChange(event: Event) {
    const target = event.target as HTMLSelectElement;
    onUpdateSelectedCategory(target.value);
  }

  function handleBulkSelectInputChange(event: Event) {
    const target = event.target as HTMLInputElement;
    onUpdateBulkSelectInput(target.value);
  }

  function handleBulkSelectKeydown(e: KeyboardEvent) {
    if (e.key === 'Enter') {
      parseAndSelectSummaries();
    }
  }
</script>

<!-- Bulk Edit Action Bar -->
{#if bulkEditState.isEnabled}
  <div class="shrink-0 border-t border-darkborderc pt-3">
    <div class="flex flex-wrap items-center justify-between gap-2">
      <!-- Left Side: Resummarize Button -->
      <div class="flex items-center gap-2">
        <!-- Resummarize Button -->
        <ShButton
          size="sm"
          variant="primary"
          onclick={onResummarize}
          disabled={bulkEditState.selectedSummaries.size < 2}
        >
          {language.hypaV3Modal.reSummarize}
        </ShButton>
      </div>
      
      <!-- Right Side: Category, Important, Bulk Select, Clear -->
      <div class="flex flex-wrap items-center gap-2">
        <!-- Category Selection -->
        <ShSelect
          size="sm"
          value={bulkEditState.selectedCategory}
          onchange={handleCategoryChange}
        >
          {#each categories as category}
            <OptionInput value={category.id}>{category.name}</OptionInput>
          {/each}
        </ShSelect>

        <!-- Apply Category Button -->
        <ShButton
          size="sm"
          variant="primary"
          onclick={applyCategoryToSelected}
          disabled={bulkEditState.selectedSummaries.size === 0}
        >
          {language.apply}
        </ShButton>

        <!-- Bulk Toggle Important Button -->
        <IconButton
          size="xl"
          style="--icon-size:16px"
          active
          onclick={bulkToggleImportant}
          disabled={bulkEditState.selectedSummaries.size === 0}
        >
          <StarIcon />
        </IconButton>

        <!-- Bulk Select by Numbers -->
        <div class="flex gap-2">
          <ShInput
            value={bulkEditState.bulkSelectInput}
            oninput={handleBulkSelectInputChange}
            placeholder="1,3,5-8"
            className="h-8 min-h-8 w-32 text-sm"
            onkeydown={handleBulkSelectKeydown}
          />
          <ShButton
            size="sm"
            variant="outline"
            onclick={parseAndSelectSummaries}
          >
            {language.select}
          </ShButton>
        </div>

        <!-- Clear Selection Button -->
        <ShButton
          size="sm"
          variant="destructive"
          onclick={clearSelection}
        >
          {language.cancel}
        </ShButton>
      </div>
    </div>
  </div>
{/if}
