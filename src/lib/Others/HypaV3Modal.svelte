<script lang="ts">
    import EmptyState from "src/lib/UI/components/EmptyState.svelte";
  import { onDestroy, untrack } from "svelte";
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
  import SummaryResult from "./HypaV3Modal/summary-result.svelte";
  import ManualSummaryPanel from "./HypaV3Modal/manual-summary-panel.svelte";
  import ModalSearch from "./HypaV3Modal/modal-search.svelte";
  import OverlayPortal from "../UI/components/overlay/OverlayPortal.svelte";
  import OverlayBackdrop from "../UI/components/overlay/OverlayBackdrop.svelte";
  
  import type {
    SummaryItemState,
    ExpandedMessageState,
    SearchState,
    SearchResult,
    SummaryResultState,
    CategoryManagerState,
    ResummarySelectionState,
    FilterState,
  } from "./HypaV3Modal/types";
  
  import {
    shouldShowSummary,
    isGuidLike,
    getCategoriesWithUnclassified,
  } from "./HypaV3Modal/utils";
  import type { OpenAIChat } from "src/ts/process/index.svelte";
  import Input from "../UI/components/Input.svelte";
  import Button from "../UI/components/Button.svelte";

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
  let resummaryState = $state<SummaryResultState | null>(null);
  let manualSummaryMode = $state(false);
  let resummaryMode = $state(false);
  let resummarySearch = $state("");

  let categoryManagerState = $state<CategoryManagerState>({
    isOpen: false,
    editingCategory: null,
  });

  let resummarySelectionState = $state<ResummarySelectionState>({
    isEnabled: false,
    selectedSummaries: new Set(),
  });

  let filterState = $state<FilterState>({
    showImportantOnly: false,
    selectedCategoryFilter: "all",
  });

  let collapsedSummaries = $state(new Set<number>());
  const summaryAbortController = new AbortController();

  onDestroy(() => {
    summaryAbortController.abort();
    $hypaV3ModalOpen = false;
  });

  function collapseAllSummaries() {
    collapsedSummaries = new Set(
      hypaV3Data.summaries.map((_, index) => index)
    );
  }

  $effect.pre(() => {
    hypaV3Data?.summaries?.length;
    filterSelected;
    filterState.showImportantOnly;
    filterState.selectedCategoryFilter;

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
    const newSelection = new Set(resummarySelectionState.selectedSummaries);
    if (newSelection.has(summaryIndex)) {
      newSelection.delete(summaryIndex);
    } else {
      newSelection.add(summaryIndex);
    }
    resummarySelectionState.selectedSummaries = newSelection;
  }

  function handleToggleManualSummaryMode() {
    manualSummaryMode = !manualSummaryMode;
    resummaryMode = false;
    resummarySearch = "";
    searchState = null;
    resummarySelectionState.isEnabled = false;
    resummarySelectionState.selectedSummaries = new Set();
    resummaryState = null;
  }

  function handleToggleResummaryMode() {
    resummaryMode = !resummaryMode;
    manualSummaryMode = false;
    resummarySearch = "";
    searchState = null;
    resummarySelectionState.isEnabled = resummaryMode;
    resummarySelectionState.selectedSummaries = new Set();
    resummaryState = null;
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
      if (!isSummaryVisible(summaryIndex)) return;

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

  function buildResummaryInput(selectedIndices: number[]): {
    oaiMessages: OpenAIChat[];
    chatMemos: string[];
  } {
    const oaiMessages = selectedIndices.map((index) => ({
      role: "user" as const,
      content: hypaV3Data.summaries[index].text,
    }));
    const chatMemos = selectedIndices.flatMap((index) =>
      hypaV3Data.summaries[index].chatMemos
    );

    return { oaiMessages, chatMemos: [...new Set(chatMemos)] };
  }

  async function resummarizeSelected() {
    if (resummarySelectionState.selectedSummaries.size < 2) return;

    const sortedIndices = Array.from(resummarySelectionState.selectedSummaries).sort((a, b) => a - b);
    const { oaiMessages, chatMemos } = buildResummaryInput(sortedIndices);

    try {
      resummaryState = {
        isProcessing: true,
        result: null,
        selectedIndices: sortedIndices,
        mergedChatMemos: chatMemos,
        isTranslating: false,
        translation: null
      };

      const resummary = await summarize(
        oaiMessages,
        true,
        {
          signal: summaryAbortController.signal,
          onRequestStatusActivate: reopenModalFromRequestStatus,
        },
      );

      resummaryState = {
        isProcessing: false,
        result: resummary,
        selectedIndices: sortedIndices,
        mergedChatMemos: chatMemos,
        isTranslating: false,
        translation: null
      };

    } catch (error) {
      if (summaryAbortController.signal.aborted) return;
      console.error('Re-summarize Failed:', error);
      resummaryState = null;
      await alertNormalWait(`Re-summarize Failed: ${error.message || error}`);
    }
  }

  async function applyResummary() {
    if (!resummaryState || !resummaryState.result) return;

    const sortedIndices = resummaryState.selectedIndices;
    const minIndex = sortedIndices[0];

    hypaV3Data.summaries[minIndex] = {
      text: resummaryState.result,
      chatMemos: resummaryState.mergedChatMemos,
      isImportant: hypaV3Data.summaries[minIndex].isImportant,
      categoryId: hypaV3Data.summaries[minIndex].categoryId,
      tags: hypaV3Data.summaries[minIndex].tags
    };
    
    for (let i = sortedIndices.length - 1; i > 0; i--) {
      hypaV3Data.summaries.splice(sortedIndices[i], 1);
    }
    
    collapseAllSummaries();
    
    resummaryState = null;
    resummarySelectionState.selectedSummaries = new Set();
    resummarySelectionState.isEnabled = false;
    resummaryMode = false;
  }

  async function rerollResummary() {
    if (!resummaryState) return;
    
    const sortedIndices = resummaryState.selectedIndices;
    const { oaiMessages } = buildResummaryInput(sortedIndices);
    
    try {
      resummaryState = {
        ...resummaryState,
        isProcessing: true,
        result: null,
        isTranslating: false,
        translation: null
      };
      
      const resummary = await summarize(
        oaiMessages,
        true,
        {
          signal: summaryAbortController.signal,
          onRequestStatusActivate: reopenModalFromRequestStatus,
        },
      );
      
      resummaryState = {
        ...resummaryState,
        isProcessing: false,
        result: resummary,
        isTranslating: false,
        translation: null
      };
      
    } catch (error) {
      if (summaryAbortController.signal.aborted) return;
      console.error('Re-summarize Retry Failed:', error);
      resummaryState = null;
      await alertNormalWait(`Re-summarize Retry Failed: ${error.message || error}`);
    }
  }

  function cancelResummary() {
    resummaryState = null;
  }

  async function toggleResummaryTranslation(regenerate: boolean = false) {
    if (!resummaryState || !resummaryState.result) return;
    const state = resummaryState;

    if (state.isTranslating) return;

    if (state.translation) {
      state.translation = null;
      return;
    }

    state.isTranslating = true;
    state.translation = "Loading...";

    try {
      state.translation = await translateHTML(state.result, false, "", -1, regenerate);
    } catch (error) {
      state.translation = `Translation failed: ${error}`;
    } finally {
      state.isTranslating = false;
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
      button.classList.add("ring-2", "ring-lightborderc");

      // Remove highlight after a short delay
      window.setTimeout(() => {
        button.classList.remove("ring-2", "ring-lightborderc");
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

  function isResummarySearchMatch(summary: SerializableSummary, index: number): boolean {
    const query = resummarySearch.trim().toLowerCase();
    if (!query) return true;

    return (index + 1).toString().includes(query)
      || summary.text.toLowerCase().includes(query)
      || summary.chatMemos.some((memo) => memo?.toLowerCase().includes(query));
  }

  function getResummarySelectedLabel(): string {
    const indices = resummaryState?.selectedIndices
      ?? Array.from(resummarySelectionState.selectedSummaries).sort((a, b) => a - b);
    const indexText = indices.map((index) => `#${index + 1}`).join(", ");
    return language.hypaV3Modal.reSummarizeSelectedSummaries.replace("{0}", indexText);
  }

  function reopenModalFromRequestStatus() {
    if (!summaryAbortController.signal.aborted) {
      $hypaV3ModalOpen = true;
    }
  }

</script>

{#snippet summaryCard(summaryIndex: number)}
  <ModalSummaryItem
    {summaryIndex}
    {hypaV3Data}
    {summaryItemStateMap}
    bind:expandedMessageState
    bind:searchState
    {filterSelected}
    {categories}
    {resummarySelectionState}
    {collapsedSummaries}
    summarySignal={summaryAbortController.signal}
    onRequestStatusActivate={reopenModalFromRequestStatus}
    onToggleSummarySelection={handleToggleSummarySelection}
    onToggleCollapse={handleToggleCollapse}
  />
{/snippet}

<OverlayPortal active={$hypaV3ModalOpen}>
<!-- Modal Backdrop -->
<OverlayBackdrop
  bind:open={$hypaV3ModalOpen}
  class="risu-modal-backdrop risu-layer-overlay flex justify-center p-1 sm:p-2"
>
    <!-- Modal Window -->
    <div
      data-hypav3-modal-window
      class="flex flex-col w-full max-w-3xl rounded-md border border-darkborderc bg-darkbg p-3 text-maintext shadow-lg sm:p-6 {hypaV3Data
        .summaries.length === 0 && !manualSummaryMode && !resummaryMode
        ? 'h-fit'
        : 'h-full'}"
    >
      <!-- Header -->
      <ModalHeader
        bind:searchState
        showImportantOnly={filterState.showImportantOnly}
        {manualSummaryMode}
        {resummaryMode}
        {filterSelected}
        onToggleImportant={() => {
          filterState.showImportantOnly = !filterState.showImportantOnly;
        }}
        onToggleFilterSelected={() => {
          filterSelected = !filterSelected;
        }}
        onResetData={handleResetData}
        onToggleManualSummaryMode={handleToggleManualSummaryMode}
        onToggleResummaryMode={handleToggleResummaryMode}
        onOpenCategoryManager={handleOpenCategoryManager}
      />

      <ManualSummaryPanel
        bind:enabled={manualSummaryMode}
        {hypaV3Data}
        summarySignal={summaryAbortController.signal}
        onRequestStatusActivate={reopenModalFromRequestStatus}
        onApplied={handleManualSummaryApplied}
      />

      {#if resummaryMode}
        {#if resummaryState}
          <div class="pb-2 text-xs text-subtext">
            {getResummarySelectedLabel()}
          </div>
          <SummaryResult
            summaryResultState={resummaryState}
            fillHeight
            onToggleTranslation={toggleResummaryTranslation}
            onReroll={rerollResummary}
            onApply={applyResummary}
            onCancel={cancelResummary}
          />
        {:else}
          <div class="flex min-h-0 flex-1 flex-col gap-3">
            <div class="flex flex-col gap-2 sm:flex-row sm:items-center">
              <Input
                placeholder={language.hypaV3Modal.reSummarizeSearchPlaceholder}
                bind:value={resummarySearch}
              />
              <Button
                variant="primary"
                className="w-full sm:w-24"
                disabled={resummarySelectionState.selectedSummaries.size < 2}
                onclick={resummarizeSelected}
              >
                {language.hypaV3Modal.reSummarize}
              </Button>
            </div>

            <div class="text-xs text-subtext">
              {language.hypaV3Modal.reSummarizeSelectedCount.replace("{0}", resummarySelectionState.selectedSummaries.size.toString())}
            </div>

            <div class="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto sm:gap-4" tabindex="-1">
              {#each hypaV3Data.summaries as summary, i (summary)}
                {#if isSummaryVisible(i) && isResummarySearchMatch(summary, i)}
                  {@render summaryCard(i)}
                {/if}
              {/each}
            </div>
          </div>
        {/if}
      {:else if !manualSummaryMode}
        {#if searchState && hypaV3Data.summaries.length > 0}
          <ModalSearch {searchState} {onSearch} />
        {/if}

        <!-- Only the summaries list scrolls between the top and bottom controls. -->
        <div class="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto sm:gap-4" tabindex="-1">
          {#if hypaV3Data.summaries.length === 0}
            <EmptyState title={language.hypaV3Modal.noSummariesLabel} description="" layout="section" density="compact" />
          {/if}

          {#each hypaV3Data.summaries as summary, i (summary)}
            {#if isSummaryVisible(i)}
              {@render summaryCard(i)}
            {/if}
          {/each}

          <NextSummarizationTarget {hypaV3Data} />
        </div>

      {/if}
    </div>
</OverlayBackdrop>

<!-- Component Modals -->
<CategoryManagerModal
  bind:categoryManagerState
  bind:searchState
  {filterState}
  onCategoryFilter={handleCategoryFilter}
/>
</OverlayPortal>
