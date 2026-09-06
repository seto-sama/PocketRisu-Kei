<script lang="ts">
    import EmptyState from "src/lib/UI/components/EmptyState.svelte";
  import {
    PlusIcon,
    XIcon,
    Trash2Icon,
    CheckIcon,
  } from "@lucide/svelte";
  import { language } from "src/lang";
  import { DBState, selectedCharID } from "src/ts/stores.svelte";
  import type { CategoryManagerState, SearchState, FilterState } from "./types";
  import { createCategoryId, getCategoriesWithUnclassified } from "./utils";
  import Dialog from "../../UI/components/Dialog.svelte";
  import Input from "../../UI/components/Input.svelte";
  import IconButton from "../../UI/components/IconButton.svelte";
  import IconButtonGroup from "../../UI/components/IconButtonGroup.svelte";
  import InlineEditableName from "../../UI/components/InlineEditableName.svelte";
  import InlineRenameAction from "../../UI/components/InlineRenameAction.svelte";
  import { InlineEditableNameController } from "src/lib/UI/components/InlineEditableNameController.svelte";

  interface Props {
    categoryManagerState: CategoryManagerState;
    searchState: SearchState;
    filterState: FilterState;
    onCategoryFilter: (categoryId: string) => void;
  }

  let {
    categoryManagerState = $bindable(),
    searchState = $bindable(),
    filterState,
    onCategoryFilter,
  }: Props = $props();

  const hypaV3Data = $derived(
    DBState.db.characters[$selectedCharID].chats[
      DBState.db.characters[$selectedCharID].chatPage
    ].hypaV3Data
  );

  let categories = $derived(
    getCategoriesWithUnclassified(hypaV3Data.categories)
  );

  function closeCategoryManager() {
    categoryManagerState.isOpen = false;
    categoryManagerState.editingCategory = null;
  }

  function startAddCategory() {
    categoryManagerState.editingCategory = { id: "", name: "" };
  }

  function saveEditingCategory() {
    if (!categoryManagerState.editingCategory) return;

    if (categoryManagerState.editingCategory.id === "") {
      addCategory(categoryManagerState.editingCategory.name);
    } else {
      updateCategory(categoryManagerState.editingCategory.id, categoryManagerState.editingCategory.name);
    }

    categoryManagerState.editingCategory = null;
  }

  function cancelEditingCategory() {
    categoryManagerState.editingCategory = null;
  }

  function addCategory(name: string) {
    const id = createCategoryId();
    hypaV3Data.categories = [
      ...getCategoriesWithUnclassified(hypaV3Data.categories),
      { id, name },
    ];
  }

  function updateCategory(id: string, name: string) {
    const trimmedName = name.trim();
    if (!trimmedName) return;
    hypaV3Data.categories = (hypaV3Data.categories || []).map(c => c.id === id ? { ...c, name: trimmedName } : c);
  }

  function deleteCategory(id: string) {
    if (id === "") return;

    for (const summary of hypaV3Data.summaries) {
      if (summary.categoryId === id) {
        summary.categoryId = undefined;
      }
    }

    hypaV3Data.categories = (hypaV3Data.categories || []).filter(c => c.id !== id);

    if (filterState.selectedCategoryFilter === id) {
      onCategoryFilter("all");
    }
  }

  function selectCategory(categoryId: string) {
    onCategoryFilter(categoryId);
    if (searchState) {
      searchState.query = '';
      searchState.results = [];
      searchState.currentResultIndex = -1;
    }
    closeCategoryManager();
  }
</script>

<!-- Category Manager Modal -->
<Dialog
  bind:open={categoryManagerState.isOpen}
  size="default"
  onOpenChange={(open) => {
    if (!open) closeCategoryManager();
  }}
>
  {#snippet title()}{language.hypaV3Modal.categoryManager}{/snippet}
  <div class="flex justify-end">
    <IconButton aria-label={language.add} title={language.add} onclick={startAddCategory}>
      <PlusIcon />
    </IconButton>
  </div>

  <div class="max-h-80 space-y-1 overflow-y-auto">
        <!-- All Categories -->
        <button
          class="flex min-h-11 w-full items-center gap-3 rounded-md border border-darkborderc px-3 py-1 text-left text-maintext transition-colors {filterState.selectedCategoryFilter === 'all'
            ? 'bg-selected'
            : 'bg-lightbg/50 risu-interactive-surface'}"
          onclick={() => selectCategory('all')}
        >
          <span class="flex-1 text-sm">{language.hypaV3Modal.allCategories} ({hypaV3Data.summaries.length})</span>
          <div class="h-6 w-12 shrink-0"></div>
        </button>

        {#each categories as category}
          {@const renameController = new InlineEditableNameController()}
          {@const count = hypaV3Data.summaries.filter(s => (s.categoryId || '') === category.id).length}
          <div
            data-inline-rename-row
            class="flex min-h-11 items-center gap-3 rounded-md border border-darkborderc px-3 py-1 text-maintext transition-colors {filterState.selectedCategoryFilter === category.id
              ? 'bg-selected'
              : 'bg-lightbg/50 risu-interactive-surface'}"
          >
            {#if categoryManagerState.editingCategory?.id === '' && category.id === ''}
              <Input
                className="h-8 min-h-8 flex-1 text-sm"
                bind:value={categoryManagerState.editingCategory.name}
                placeholder={language.hypaV3Modal.categoryName}
              />
              <IconButtonGroup>
                <IconButton active activeColor="primary" onclick={saveEditingCategory}>
                  <CheckIcon />
                </IconButton>
                <IconButton onclick={cancelEditingCategory}>
                  <XIcon />
                </IconButton>
              </IconButtonGroup>
            {:else}
              <InlineEditableName
                controller={renameController}
                value={category.name}
                label={`${category.name} (${count})`}
                disabled={category.id === ''}
                onActivate={() => selectCategory(category.id)}
                onCommit={(value) => updateCategory(category.id, value)}
              />
              {#if category.id !== ""}
                <IconButtonGroup>
                  <InlineRenameAction controller={renameController} />
                  <IconButton tone="destructive" onclick={() => deleteCategory(category.id)}>
                    <Trash2Icon />
                  </IconButton>
                </IconButtonGroup>
              {:else}
                <div class="h-6 w-12 shrink-0"></div>
              {/if}
            {/if}
          </div>
        {/each}

        <!-- Empty State -->
        {#if categories.filter(c => c.id !== "").length === 0 && !categoryManagerState.editingCategory}
          <EmptyState title={language.hypaV3Modal.noCategoriesYet} description={language.hypaV3Modal.addNewCategoryHint} layout="section" />
        {/if}
  </div>
</Dialog>
