<script lang="ts">
  import { untrack } from "svelte";
  import { 
    type SerializableSummary, 
    summarize,
  } from "src/ts/process/memory/hypav3";
  import { alertNormalWait } from "src/ts/alert";
  import { DBState, selectedCharID, hypaV3ModalOpen } from "src/ts/stores.svelte";
  import { language } from "src/lang";
  import { translateHTML } from "src/ts/translator/translator";
  import { alertConfirmTwice } from "./HypaV3Modal/utils";
  import ModalHeader from "./HypaV3Modal/modal-header.svelte";
  import ModalSummaryItem from "./HypaV3Modal/modal-summary-item.svelte";
  import NextSummarizationTarget from "./HypaV3Modal/next-summarization-target.svelte";
  import CategoryManagerModal from "./HypaV3Modal/category-manager-modal.svelte";
  import BulkEditActions from "./HypaV3Modal/bulk-edit-actions.svelte";
  import BulkResummaryResult from "./HypaV3Modal/bulk-resummary-result.svelte";
  import ManualSummaryPanel from "./HypaV3Modal/manual-summary-panel.svelte";
  import ModalSearch from "./HypaV3Modal/modal-search.svelte";
  
  import type {
    SummaryItemState,
    ExpandedMessageState,
    SearchState,
    SearchResult,
    BulkResummaryState,
    CategoryManagerState,
    BulkEditState,
    FilterState,
  } from "./HypaV3Modal/types";
  
  import {
    shouldShowSummary,
    isGuidLike,
    parseSelectionInput,
    getCategoriesWithUnclassified,
  } from "./HypaV3Modal/utils";
  import type { OpenAIChat } from "src/ts/process/index.svelte";

  const hypaV3Data = $derived(
    DBState.db.characters[$selectedCharID].chats[
      DBState.db.characters[$selectedCharID].chatPage
    ].hypaV3Data
  );

  let categories = $derived(
    getCategoriesWithUnclassified(hypaV3Data.categories)
  );

  let summaryItemStateMap = new WeakMap<SerializableSummary, SummaryItemState>();
  let expandedMessageState = $state<ExpandedMessageState>(null);
  let searchState = $state<SearchState>(null);
  let filterSelected = $state(false);
  let bulkResummaryState = $state<BulkResummaryState | null>(null);
  let manualSummaryMode = $state(false);

  let categoryManagerState = $state<CategoryManagerState>({
    isOpen: false,
    editingCategory: null,
  });

  let bulkEditState = $state<BulkEditState>({
    isEnabled: false,
    selectedSummaries: new Set(),
    selectedCategory: "",
    bulkSelectInput: "",
  });

  let filterState = $state<FilterState>({
    showImportantOnly: false,
    selectedCategoryFilter: "all",
  });

  let collapsedSummaries = $state(new Set<number>());

  function collapseAllSummaries() {
    collapsedSummaries = new Set(
      hypaV3Data.summaries.map((_, index) => index)
    );
  }

  $effect.pre(() => {
    hypaV3Data?.summaries?.length;
    filterSelected;

    untrack(() => {
      DBState.db.characters[$selectedCharID].chats[
        DBState.db.characters[$selectedCharID].chatPage
      ].hypaV3Data ??= {
        summaries: [],
        categories: [{ id: "", name: language.hypaV3Modal.unclassified }],
        lastSelectedSummaries: [],
      };

      expandedMessageState = null;
      searchState = null;
      
      collapseAllSummaries();
    });
  });

  $effect(() => {
    if ($hypaV3ModalOpen) {
      const currentImportantCount = untrack(() => hypaV3Data.summaries.filter(s => s.isImportant).length);

      if (currentImportantCount > 0) {
        filterState.selectedCategoryFilter = "all";
        filterState.showImportantOnly = true;
      } else {
        filterState.selectedCategoryFilter = "";
        filterState.showImportantOnly = false;
      }

    }
  });

  function handleToggleSummarySelection(summaryIndex: number) {
    const newSelection = new Set(bulkEditState.selectedSummaries);
    if (newSelection.has(summaryIndex)) {
      newSelection.delete(summaryIndex);
    } else {
      newSelection.add(summaryIndex);
    }
    bulkEditState.selectedSummaries = newSelection;
  }

  function handleToggleManualSummaryMode() {
    manualSummaryMode = !manualSummaryMode;
    searchState = null;
    bulkEditState.isEnabled = false;
  }

  function handleManualSummaryApplied() {
    collapseAllSummaries();
  }

  // Search functionality
  function onSearch(e: KeyboardEvent) {
    if (e.key === "Enter") {
      if (!searchState || !searchState.query.trim()) return;

      // Perform search
      performSearch(searchState.query, e.shiftKey);
    }
  }

  function performSearch(query: string, backward: boolean = false) {
    if (!searchState) return;

    // Reset results if query changed
    if (searchState.results.length === 0) {
      searchState.results = findAllMatches(query);
      searchState.currentResultIndex = -1;
    }

    // Navigate to next/previous result
    const result = getNextSearchResult(backward);
    if (result) {
      navigateToSearchResult(result);
    }
  }

  function findAllMatches(query: string): SearchResult[] {
    const results: SearchResult[] = [];
    const lowerQuery = query.toLowerCase();

    hypaV3Data.summaries.forEach((summary, summaryIndex) => {
      // Search in summary text
      const summaryText = summary.text.toLowerCase();
      let index = 0;
      while ((index = summaryText.indexOf(lowerQuery, index)) !== -1) {
        results.push({
          type: "summary",
          summaryIndex,
          start: index,
          end: index + query.length,
        });
        index += query.length;
      }

      // Search in chat memos (if they're GUIDs)
      if (isGuidLike(query)) {
        summary.chatMemos.forEach((chatMemo, memoIndex) => {
          if (chatMemo && chatMemo.toLowerCase().includes(lowerQuery)) {
            results.push({
              type: "chatmemo",
              summaryIndex,
              memoIndex,
            });
          }
        });
      }
    });

    return results;
  }

  async function resummarizeBulkSelected() {
    if (bulkEditState.selectedSummaries.size < 2) return;

    const sortedIndices = Array.from(bulkEditState.selectedSummaries).sort((a, b) => a - b);

    try {
      bulkResummaryState = {
        isProcessing: true,
        result: null,
        selectedIndices: sortedIndices,
        mergedChatMemos: [],
        isTranslating: false,
        translation: null
      };

      const selectedSummaryTexts = sortedIndices.map(index =>
        hypaV3Data.summaries[index].text
      );

      const oaiMessages: OpenAIChat[] = selectedSummaryTexts.map(text => ({
        role: "user",
        content: text
      }));

      const mergedChatMemos: string[] = [];
      for (const index of sortedIndices) {
        const summary = hypaV3Data.summaries[index];
        mergedChatMemos.push(...summary.chatMemos);
      }

      const uniqueChatMemos = [...new Set(mergedChatMemos)];

      const resummary = await summarize(oaiMessages, true);

      bulkResummaryState = {
        isProcessing: false,
        result: resummary,
        selectedIndices: sortedIndices,
        mergedChatMemos: uniqueChatMemos,
        isTranslating: false,
        translation: null
      };

    } catch (error) {
      console.error('Re-summarize Failed:', error);
      bulkResummaryState = null;
      await alertNormalWait(`Re-summarize Failed: ${error.message || error}`);
    }
  }

  async function applyBulkResummary() {
    if (!bulkResummaryState || !bulkResummaryState.result) return;

    const sortedIndices = bulkResummaryState.selectedIndices;
    const minIndex = sortedIndices[0];

    hypaV3Data.summaries[minIndex] = {
      text: bulkResummaryState.result,
      chatMemos: bulkResummaryState.mergedChatMemos,
      isImportant: hypaV3Data.summaries[minIndex].isImportant,
      categoryId: hypaV3Data.summaries[minIndex].categoryId,
      tags: hypaV3Data.summaries[minIndex].tags
    };
    
    for (let i = sortedIndices.length - 1; i > 0; i--) {
      hypaV3Data.summaries.splice(sortedIndices[i], 1);
    }
    
    collapseAllSummaries();
    
    bulkResummaryState = null;
    bulkEditState.selectedSummaries = new Set();
  }

  async function rerollBulkResummary() {
    if (!bulkResummaryState) return;
    
    const sortedIndices = bulkResummaryState.selectedIndices;
    
    try {
      bulkResummaryState = {
        ...bulkResummaryState,
        isProcessing: true,
        result: null,
        isTranslating: false,
        translation: null
      };
      
      const selectedSummaryTexts = sortedIndices.map(index => 
        hypaV3Data.summaries[index].text
      );
      
      const oaiMessages: OpenAIChat[] = selectedSummaryTexts.map(text => ({
        role: "user",
        content: text
      }));
      
      const resummary = await summarize(oaiMessages, true);
      
      bulkResummaryState = {
        ...bulkResummaryState,
        isProcessing: false,
        result: resummary,
        isTranslating: false,
        translation: null
      };
      
    } catch (error) {
      console.error('Re-summarize Retry Failed:', error);
      bulkResummaryState = null;
      await alertNormalWait(`Re-summarize Retry Failed: ${error.message || error}`);
    }
  }

  function cancelBulkResummary() {
    bulkResummaryState = null;
    bulkEditState.selectedSummaries = new Set();
  }

  async function toggleBulkResummaryTranslation(regenerate: boolean = false) {
    if (!bulkResummaryState || !bulkResummaryState.result) return;
    
    if (bulkResummaryState.isTranslating) return;

    if (bulkResummaryState.translation) {
      bulkResummaryState.translation = null;
      return;
    }

    bulkResummaryState.isTranslating = true;
    bulkResummaryState.translation = "Loading...";

    try {
      const result = await translateHTML(bulkResummaryState.result, false, "", -1, regenerate);
      
      bulkResummaryState.translation = result;
    } catch (error) {
      bulkResummaryState.translation = `Translation failed: ${error}`;
    } finally {
      bulkResummaryState.isTranslating = false;
    }
  }

  async function handleResetData() {
    if (
      await alertConfirmTwice(
        language.hypaV3Modal.resetConfirmMessage,
        language.hypaV3Modal.resetConfirmSecondMessage
      )
    ) {
      DBState.db.characters[$selectedCharID].chats[
        DBState.db.characters[$selectedCharID].chatPage
      ].hypaV3Data = {
        summaries: [],
      };
    }
  }

  function handleToggleBulkEditMode() {
    bulkEditState.isEnabled = !bulkEditState.isEnabled;
    if (!bulkEditState.isEnabled) {
      bulkEditState.selectedSummaries = new Set();
    }
  }

  function handleBulkEditClearSelection() {
    bulkEditState.selectedSummaries = new Set();
  }

  function handleBulkEditUpdateSelectedCategory(categoryId: string) {
    bulkEditState.selectedCategory = categoryId;
  }

  function handleBulkEditUpdateBulkSelectInput(input: string) {
    bulkEditState.bulkSelectInput = input;
  }

  function handleBulkEditApplyCategory() {
    if (bulkEditState.selectedSummaries.size === 0) return;

    for (const summaryIndex of bulkEditState.selectedSummaries) {
      hypaV3Data.summaries[summaryIndex].categoryId = bulkEditState.selectedCategory || undefined;
    }

    handleBulkEditClearSelection();
  }

  function handleBulkEditToggleImportant() {
    if (bulkEditState.selectedSummaries.size === 0) return;
    const selectedIndices = Array.from(bulkEditState.selectedSummaries);
    const hasNonImportant = selectedIndices.some(index => !hypaV3Data.summaries[index].isImportant);

    selectedIndices.forEach(index => {
      const summary = hypaV3Data.summaries[index];
      hasNonImportant ? summary.isImportant = true : summary.isImportant = false;
    });
    handleBulkEditClearSelection();
  }

  function handleBulkEditParseAndSelectSummaries() {
    if (!bulkEditState.bulkSelectInput.trim()) return;
    
    const newSelection = parseSelectionInput(bulkEditState.bulkSelectInput, hypaV3Data.summaries.length);
    const filteredSelection = new Set<number>();
    
    for (const index of newSelection) {
      if (shouldShowSummary(hypaV3Data.summaries[index], index, filterState.showImportantOnly, filterState.selectedCategoryFilter)) {
        filteredSelection.add(index);
      }
    }

    bulkEditState.selectedSummaries = filteredSelection;
    bulkEditState.bulkSelectInput = "";
  }

  function handleOpenCategoryManager() {
    categoryManagerState.isOpen = true;
  }

  function handleCategoryFilter(categoryId: string) {
    filterState.selectedCategoryFilter = categoryId;
  }

  function handleToggleCollapse(summaryIndex: number) {
    const newCollapsed = new Set(collapsedSummaries);
    if (newCollapsed.has(summaryIndex)) {
      newCollapsed.delete(summaryIndex);
    } else {
      newCollapsed.add(summaryIndex);
    }
    collapsedSummaries = newCollapsed;
  }

  function getNextSearchResult(backward: boolean): SearchResult | null {
    if (!searchState || searchState.results.length === 0) return null;

    let nextIndex: number;

    if (searchState.requestedSearchFromIndex !== -1) {
      const fromSummaryIndex = searchState.requestedSearchFromIndex;

      nextIndex = backward
        ? searchState.results.findLastIndex(
            (r) => r.summaryIndex <= fromSummaryIndex
          )
        : searchState.results.findIndex(
            (r) => r.summaryIndex >= fromSummaryIndex
          );

      if (nextIndex === -1) {
        nextIndex = backward ? searchState.results.length - 1 : 0;
      }

      searchState.requestedSearchFromIndex = -1;
    } else {
      const delta = backward ? -1 : 1;

      nextIndex =
        (searchState.currentResultIndex + delta + searchState.results.length) %
        searchState.results.length;
    }

    searchState.currentResultIndex = nextIndex;
    return searchState.results[nextIndex];
  }

  function navigateToSearchResult(result: SearchResult) {
    if (!searchState) return;
    searchState.isNavigating = true;

    if (result.type === "summary") {
      const summary = hypaV3Data.summaries[result.summaryIndex];
      const summaryItemState = summaryItemStateMap.get(summary);
      const textarea = summaryItemState?.originalRef;
      if (!textarea) {
        searchState.isNavigating = false;
        return;
      }

      // Scroll to element
      textarea.scrollIntoView({
        behavior: "instant",
        block: "center",
      });

      if (result.start === result.end) {
        searchState.isNavigating = false;
        return;
      }

      // Scroll to query
      textarea.setSelectionRange(result.start, result.end);
      scrollToSelection(textarea);

    } else {
      const summary = hypaV3Data.summaries[result.summaryIndex];
      const summaryItemState = summaryItemStateMap.get(summary);
      const button = summaryItemState?.chatMemoRefs[result.memoIndex];
      if (!button) {
        searchState.isNavigating = false;
        return;
      }

      // Scroll to element
      button.scrollIntoView({
        behavior: "instant",
        block: "center",
      });

      // Highlight chatMemo
      button.classList.add("ring-2", "ring-borderc");

      // Remove highlight after a short delay
      window.setTimeout(() => {
        button.classList.remove("ring-2", "ring-borderc");
      }, 1000);
    }

    searchState.isNavigating = false;
  }

  function scrollToSelection(textarea: HTMLTextAreaElement) {
    const { selectionStart, selectionEnd } = textarea;

    if (
      selectionStart === null ||
      selectionEnd === null ||
      selectionStart === selectionEnd
    ) {
      return; // Exit if there is no selected text
    }

    // Calculate the text before the selected position based on the textarea's text
    const textBeforeSelection = textarea.value.substring(0, selectionStart);

    // Use a temporary DOM element to calculate the exact position of the selected text
    const tempDiv = document.createElement("div");
    tempDiv.style.position = "absolute";
    tempDiv.style.whiteSpace = "pre-wrap";
    tempDiv.style.overflowWrap = "break-word";
    tempDiv.style.font = window.getComputedStyle(textarea).font;
    tempDiv.style.width = `${textarea.offsetWidth}px`;
    tempDiv.style.visibility = "hidden"; // Set it to be invisible

    tempDiv.textContent = textBeforeSelection;
    document.body.appendChild(tempDiv);

    // Calculate the position of the selected text within the textarea
    const selectionTop = tempDiv.offsetHeight;
    document.body.removeChild(tempDiv);

    // Adjust the scroll so that the selected text is centered on the screen
    textarea.scrollTop = selectionTop - textarea.clientHeight / 2;
  }

  function isSummaryVisible(index: number): boolean {
    const summary = hypaV3Data.summaries[index];
    
    // Use the new shouldShowSummary utility function
    return shouldShowSummary(
      summary, 
      index, 
      filterState.showImportantOnly, 
      filterState.selectedCategoryFilter
    ) && (
      !filterSelected ||
      !hypaV3Data.metrics ||
      hypaV3Data.metrics.lastImportantSummaries.includes(index) ||
      hypaV3Data.metrics.lastRecentSummaries.includes(index) ||
      hypaV3Data.metrics.lastSimilarSummaries.includes(index) ||
      hypaV3Data.metrics.lastRandomSummaries.includes(index)
    );
  }

</script>

<!-- Modal Backdrop -->
<div class="fixed inset-0 z-40 bg-black/50 p-1 sm:p-2">
  <!-- Modal Wrapper -->
  <div class="flex justify-center w-full h-full">
    <!-- Modal Window -->
    <div
      class="flex flex-col w-full max-w-3xl rounded-md border border-darkborderc bg-darkbg p-3 text-textcolor shadow-lg sm:p-6 {hypaV3Data
        .summaries.length === 0 && !manualSummaryMode
        ? 'h-fit'
        : 'h-full'}"
    >
      <!-- Header -->
      <ModalHeader
        bind:searchState
        showImportantOnly={filterState.showImportantOnly}
        {manualSummaryMode}
        {filterSelected}
        bulkEditEnabled={bulkEditState.isEnabled}
        onToggleImportant={() => {
          filterState.showImportantOnly = !filterState.showImportantOnly;
        }}
        onToggleFilterSelected={() => {
          filterSelected = !filterSelected;
        }}
        onResetData={handleResetData}
        onToggleManualSummaryMode={handleToggleManualSummaryMode}
        onToggleBulkEditMode={handleToggleBulkEditMode}
        onOpenCategoryManager={handleOpenCategoryManager}
      />

      <ManualSummaryPanel
        bind:enabled={manualSummaryMode}
        {hypaV3Data}
        onApplied={handleManualSummaryApplied}
      />

      {#if !manualSummaryMode}
        {#if searchState && hypaV3Data.summaries.length > 0}
          <ModalSearch {searchState} {onSearch} />
        {/if}

        <!-- Only the summaries list scrolls between the top and bottom controls. -->
        <div class="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto sm:gap-4" tabindex="-1">
          {#if hypaV3Data.summaries.length === 0}
            <div class="p-4 text-center text-textcolor2 sm:p-3 md:p-4">
              {language.hypaV3Modal.noSummariesLabel}
            </div>
          {/if}

          {#each hypaV3Data.summaries as summary, i (summary)}
            {#if isSummaryVisible(i)}
              <ModalSummaryItem
                summaryIndex={i}
                {hypaV3Data}
                {summaryItemStateMap}
                bind:expandedMessageState
                bind:searchState
                {filterSelected}
                {categories}
                {bulkEditState}
                {collapsedSummaries}
                onToggleSummarySelection={handleToggleSummarySelection}
                onToggleCollapse={handleToggleCollapse}
              />
            {/if}
          {/each}

          <NextSummarizationTarget {hypaV3Data} />
        </div>

        <BulkResummaryResult
          {bulkResummaryState}
          onToggleTranslation={toggleBulkResummaryTranslation}
          onReroll={rerollBulkResummary}
          onApply={applyBulkResummary}
          onCancel={cancelBulkResummary}
        />

        {#if !bulkResummaryState}
          <BulkEditActions
            {bulkEditState}
            {categories}
            onResummarize={resummarizeBulkSelected}
            onClearSelection={handleBulkEditClearSelection}
            onUpdateSelectedCategory={handleBulkEditUpdateSelectedCategory}
            onUpdateBulkSelectInput={handleBulkEditUpdateBulkSelectInput}
            onApplyCategory={handleBulkEditApplyCategory}
            onToggleImportant={handleBulkEditToggleImportant}
            onParseAndSelectSummaries={handleBulkEditParseAndSelectSummaries}
          />
        {/if}
      {/if}
    </div>
  </div>
</div>

<!-- Component Modals -->
<CategoryManagerModal
  bind:categoryManagerState
  bind:searchState
  {filterState}
  onCategoryFilter={handleCategoryFilter}
/>
