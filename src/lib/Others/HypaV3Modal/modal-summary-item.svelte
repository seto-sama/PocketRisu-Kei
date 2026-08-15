<script lang="ts">
  import { tick, untrack } from "svelte";
  import {
    LanguagesIcon,
    StarIcon,
    RefreshCw,
    Trash2Icon,
    ScissorsLineDashed,
    XIcon,
    CheckIcon,
    TagIcon,
    ChevronDownIcon as CategoryChevronDownIcon,
    ChevronUpIcon,
    ChevronDownIcon,
  } from "@lucide/svelte";
  import { language } from "src/lang";
  import {
    type SerializableHypaV3Data,
    type SerializableSummary,
    summarize,
    getCurrentHypaV3Preset,
  } from "src/ts/process/memory/hypav3";
  import { type OpenAIChat } from "src/ts/process/index.svelte";
  import { type Message } from "src/ts/storage/database.svelte";
  import { translateHTML } from "src/ts/translator/translator";
  import { alertConfirm } from "src/ts/alert";
  import { DBState, selectedCharID } from "src/ts/stores.svelte";
  import type {
    SummaryItemState,
    ExpandedMessageState,
    SearchState,
    Category,
    BulkEditState,
  } from "./types";
  import {
    alertConfirmTwice,
    handleDualAction,
    getFirstMessage,
    processHypaV3Message,
    getCategoryName,
  } from "./utils";
  import IconButton from "src/lib/UI/GUI/IconButton.svelte";
  import IconButtonGroup from "src/lib/UI/GUI/IconButtonGroup.svelte";
  import TextAreaInput from "src/lib/UI/GUI/TextAreaInput.svelte";
  import ShBadge from "src/lib/UI/GUI/ShBadge.svelte";
  import ShButton from "src/lib/UI/GUI/ShButton.svelte";
  import ShDropdownMenu from "src/lib/UI/GUI/ShDropdownMenu.svelte";
  import ShDropdownMenuContent from "src/lib/UI/GUI/ShDropdownMenuContent.svelte";
  import ShDropdownMenuItem from "src/lib/UI/GUI/ShDropdownMenuItem.svelte";
  import ShDropdownMenuTrigger from "src/lib/UI/GUI/ShDropdownMenuTrigger.svelte";
  import CheckInput from "src/lib/UI/GUI/CheckInput.svelte";

  interface Props {
    summaryIndex: number;
    hypaV3Data: SerializableHypaV3Data;
    summaryItemStateMap: WeakMap<SerializableSummary, SummaryItemState>;
    expandedMessageState: ExpandedMessageState;
    searchState: SearchState;
    filterSelected: boolean;
    categories: Category[];
    bulkEditState: BulkEditState;
    collapsedSummaries: Set<number>;
    onToggleSummarySelection: (index: number) => void;
    onToggleCollapse: (index: number) => void;
  }

  let {
    summaryIndex,
    hypaV3Data,
    summaryItemStateMap,
    expandedMessageState = $bindable(),
    searchState = $bindable(),
    filterSelected,
    categories,
    bulkEditState,
    collapsedSummaries,
    onToggleSummarySelection,
    onToggleCollapse,
  }: Props = $props();

  const summary = $derived(hypaV3Data.summaries[summaryIndex]);
  const summaryItemState = $state<SummaryItemState>({
    originalRef: null,
    translationRef: null,
    rerolledTranslationRef: null,
    chatMemoRefs: null,
  });

  let isTranslating = $state(false);
  let translation = $state<string | null>(null);
  let isRerolling = $state(false);
  let rerolled = $state<string | null>(null);
  let isTranslatingRerolled = $state(false);
  let rerolledTranslation = $state<string | null>(null);

  $effect.pre(() => {
    summaryItemStateMap.set(summary, summaryItemState);
  });

  $effect.pre(() => {
    summary?.chatMemos?.length;

    untrack(() => {
      summaryItemState.chatMemoRefs = new Array(summary.chatMemos.length).fill(
        null
      );

      expandedMessageState = null;
      searchState = null;
    });
  });

  async function toggleTranslate(regenerate: boolean): Promise<void> {
    if (isTranslating) return;

    if (translation) {
      translation = null;
      return;
    }

    isTranslating = true;
    translation = "Loading...";

    // Focus on translation element after it's rendered
    await tick();

    if (summaryItemState.translationRef) {
      summaryItemState.translationRef.focus();
      summaryItemState.translationRef.scrollIntoView({
        behavior: "smooth",
        block: "nearest",
      });
    }

    // Translate
    const result = await translate(summary.text, regenerate);

    translation = result;
    isTranslating = false;
  }

  async function translate(text: string, regenerate: boolean): Promise<string> {
    try {
      return await translateHTML(text, false, "", -1, regenerate);
    } catch (error) {
      return `Translation failed: ${error}`;
    }
  }

  function toggleImportant(): void {
    summary.isImportant = !summary.isImportant;
  }

  function isOrphan(): boolean {
    const char = DBState.db.characters[$selectedCharID];
    const chat = char.chats[DBState.db.characters[$selectedCharID].chatPage];

    for (const chatMemo of summary.chatMemos) {
      if (chatMemo == null) {
        // Check first message exists
        if (!getFirstMessage()) return true;
      } else {
        if (chat.message.findIndex((m) => m.chatId === chatMemo) === -1)
          return true;
      }
    }

    return false;
  }

  async function toggleReroll(): Promise<void> {
    if (isRerolling) return;
    if (isOrphan()) return;

    isRerolling = true;
    rerolled = "Loading...";

    try {
      const toSummarize: OpenAIChat[] = await Promise.all(
        summary.chatMemos.map(async (chatMemo) => {
          const message = await getMessageFromChatMemo(chatMemo);

          return {
            role: (message.role === "char"
              ? "assistant"
              : message.role) as OpenAIChat["role"],
            content: message.data,
          };
        })
      );

      const summarizeResult = await summarize(toSummarize);

      rerolled = summarizeResult;
    } catch (error) {
      rerolled = "Reroll failed";
    } finally {
      isRerolling = false;
    }
  }

  async function getMessageFromChatMemo(
    chatMemo: string | null
  ): Promise<Message | null> {
    const char = DBState.db.characters[$selectedCharID];
    const chat = char.chats[DBState.db.characters[$selectedCharID].chatPage];
    const shouldProcess = getCurrentHypaV3Preset().settings.processRegexScript;

    let msg = null;
    let msgIndex = -1;

    if (chatMemo == null) {
      const firstMessage = getFirstMessage();

      if (!firstMessage) return null;
      msg = { role: "char", data: firstMessage };
    } else {
      msgIndex = chat.message.findIndex((m) => m.chatId === chatMemo);
      if (msgIndex === -1) return null;
      msg = chat.message[msgIndex];
    }

    return await processHypaV3Message(
      msg,
      msgIndex,
      shouldProcess,
      chatMemo == null
    );
  }

  async function deleteThis(): Promise<void> {
    if (await alertConfirm(language.hypaV3Modal.deleteThisConfirmMessage)) {
      hypaV3Data.summaries = hypaV3Data.summaries.filter(
        (_, i) => i !== summaryIndex
      );
    }
  }

  async function deleteAfter(): Promise<void> {
    if (
      await alertConfirmTwice(
        language.hypaV3Modal.deleteAfterConfirmMessage,
        language.hypaV3Modal.deleteAfterConfirmSecondMessage
      )
    ) {
      hypaV3Data.summaries.splice(summaryIndex + 1);
    }
  }

  async function toggleTranslateRerolled(regenerate: boolean): Promise<void> {
    if (isTranslatingRerolled) return;

    if (rerolledTranslation) {
      rerolledTranslation = null;
      return;
    }

    if (!rerolled) return;

    isTranslatingRerolled = true;
    rerolledTranslation = "Loading...";

    // Focus on rerolled translation element after it's rendered
    await tick();

    if (summaryItemState.rerolledTranslationRef) {
      summaryItemState.rerolledTranslationRef.focus();
      summaryItemState.rerolledTranslationRef.scrollIntoView({
        behavior: "smooth",
        block: "nearest",
      });
    }

    // Translate
    const result = await translate(rerolled, regenerate);

    rerolledTranslation = result;
    isTranslatingRerolled = false;
  }

  function cancelRerolled(): void {
    rerolled = null;
    rerolledTranslation = null;
  }

  function applyRerolled(): void {
    summary.text = rerolled;
    translation = null;
    rerolled = null;
    rerolledTranslation = null;
  }

  async function toggleTranslateExpandedMessage(
    regenerate: boolean
  ): Promise<void> {
    if (!expandedMessageState || expandedMessageState.isTranslating) return;

    if (expandedMessageState.translation) {
      expandedMessageState.translation = null;
      return;
    }

    const message = await getMessageFromChatMemo(
      expandedMessageState.selectedChatMemo
    );

    if (!message) return;

    expandedMessageState.isTranslating = true;
    expandedMessageState.translation = "Loading...";

    // Focus on translation element after it's rendered
    await tick();

    if (expandedMessageState.translationRef) {
      expandedMessageState.translationRef.focus();
      expandedMessageState.translationRef.scrollIntoView({
        behavior: "smooth",
        block: "nearest",
      });
    }

    // Translate
    const result = await translate(message.data, regenerate);

    expandedMessageState.translation = result;
    expandedMessageState.isTranslating = false;
  }

  function isMessageExpanded(chatMemo: string | null): boolean {
    if (!expandedMessageState) return false;

    return (
      expandedMessageState.summaryIndex === summaryIndex &&
      expandedMessageState.selectedChatMemo === chatMemo
    );
  }

  function toggleExpandMessage(chatMemo: string | null): void {
    expandedMessageState = isMessageExpanded(chatMemo)
      ? null
      : {
          summaryIndex,
          selectedChatMemo: chatMemo,
          isTranslating: false,
          translation: null,
          translationRef: null,
        };
  }

  function toggleSummaryCollapse(): void {
    onToggleCollapse(summaryIndex);
  }

  function isCollapsed(): boolean {
    return collapsedSummaries.has(summaryIndex);
  }

  function isSelected(): boolean {
    return bulkEditState.selectedSummaries.has(summaryIndex);
  }
</script>

<div
  class="flex flex-col rounded-md border bg-bgcolor/50 p-2 text-textcolor sm:p-4 {isSelected() ? 'border-borderc' : 'border-darkborderc'}"
>
  <!-- Original Summary Header -->
  <div class="flex items-center justify-between">
    <!-- Summary Number / Metrics Container -->
    <div class="flex min-w-0 flex-wrap items-center gap-2">
      <!-- Bulk Edit Checkbox -->
      {#if bulkEditState.isEnabled}
        <CheckInput
          card
          check={isSelected()}
          hiddenName
          margin={false}
          name={language.hypaV3Modal.summaryNumberLabel.replace(
            "{0}",
            (summaryIndex + 1).toString()
          )}
          onChange={() => onToggleSummarySelection(summaryIndex)}
        />
      {/if}

      <span class="text-sm text-textcolor2"
        >{language.hypaV3Modal.summaryNumberLabel.replace(
          "{0}",
          (summaryIndex + 1).toString()
        )}</span
      >

      <ShDropdownMenu>
        <ShDropdownMenuTrigger>
          {#snippet child({ props })}
            <ShButton
              {...props}
              size="xs"
              variant="secondary"
              title={language.hypaV3Modal.categoryManager}
            >
              <TagIcon />
              {getCategoryName(summary.categoryId, categories)}
              <CategoryChevronDownIcon />
            </ShButton>
          {/snippet}
        </ShDropdownMenuTrigger>
        <ShDropdownMenuContent align="start" class="z-[45] min-w-40">
          {#each categories as category}
            <ShDropdownMenuItem
              onSelect={() => {
                summary.categoryId = category.id || undefined;
              }}
            >
              <TagIcon />
              <span class="flex-1">{category.name}</span>
              {#if (summary.categoryId || "") === category.id}
                <CheckIcon class="text-primary" />
              {/if}
            </ShDropdownMenuItem>
          {/each}
        </ShDropdownMenuContent>
      </ShDropdownMenu>

      {#if filterSelected && hypaV3Data.metrics}
        <div class="flex flex-wrap gap-1">
          {#if hypaV3Data.metrics.lastImportantSummaries.includes(summaryIndex)}
            <ShBadge variant="info">
              Important
            </ShBadge>
          {/if}
          {#if hypaV3Data.metrics.lastRecentSummaries.includes(summaryIndex)}
            <ShBadge variant="secondary">
              Recent
            </ShBadge>
          {/if}
          {#if hypaV3Data.metrics.lastSimilarSummaries.includes(summaryIndex)}
            <ShBadge variant="success">
              Similar
            </ShBadge>
          {/if}
          {#if hypaV3Data.metrics.lastRandomSummaries.includes(summaryIndex)}
            <ShBadge variant="warning">
              Random
            </ShBadge>
          {/if}
        </div>
      {/if}
    </div>

    <!-- Buttons Container -->
    <IconButtonGroup>
      <!-- Translate Button -->
      <span
        class="inline-flex"
        use:handleDualAction={{
          onMainAction: () => toggleTranslate(false),
          onAlternativeAction: () => toggleTranslate(true),
        }}
      >
        <IconButton tabindex={-1}>
          <LanguagesIcon />
        </IconButton>
      </span>

      <!-- Important Button -->
      <IconButton
        active={summary.isImportant}
        tabindex={-1}
        onclick={toggleImportant}
      >
        <StarIcon />
      </IconButton>

      <!-- Reroll Button -->
      <IconButton
        tabindex={-1}
        disabled={isOrphan()}
        onclick={async () => await toggleReroll()}
      >
        <RefreshCw />
      </IconButton>

      <!-- Delete This Button -->
      <IconButton
        tone="destructive"
        tabindex={-1}
        onclick={async () => await deleteThis()}
      >
        <Trash2Icon />
      </IconButton>

      <!-- Delete After Button -->
      <IconButton
        tone="destructive"
        tabindex={-1}
        onclick={async () => await deleteAfter()}
      >
        <ScissorsLineDashed />
      </IconButton>
    </IconButtonGroup>
  </div>

  <!-- Original Summary -->
  <div class="mt-2 sm:mt-4">
    <TextAreaInput
      fullwidth
      actionBar
      className="bg-darkbg"
      bind:textareaRef={summaryItemState.originalRef}
      bind:value={summary.text}
      onfocus={() => {
        if (searchState && !searchState.isNavigating) {
          searchState.requestedSearchFromIndex = summaryIndex;
        }
      }}
    />
  </div>

  <!-- Original Summary Translation -->
  {#if translation}
    <div class="mt-2 sm:mt-4">
      <div class="mb-2 text-sm text-textcolor2 sm:mb-4">
        {language.hypaV3Modal.translationLabel}
      </div>

      <TextAreaInput
        fullwidth
        actionBar
        className="bg-darkbg"
        readonly
        tabindex={-1}
        bind:textareaRef={summaryItemState.translationRef}
        bind:value={translation}
      />
    </div>
  {/if}

  {#if rerolled}
    <!-- Rerolled Summary Header -->
    <div class="mt-2 sm:mt-4">
      <div class="flex items-center justify-between">
        <span class="text-sm text-textcolor2"
          >{language.hypaV3Modal.rerolledSummaryLabel}</span
        >
        <IconButtonGroup>
          <!-- Translate Rerolled Button -->
          <span
            class="inline-flex"
            use:handleDualAction={{
              onMainAction: () => toggleTranslateRerolled(false),
              onAlternativeAction: () => toggleTranslateRerolled(true),
            }}
          >
            <IconButton tabindex={-1}>
              <LanguagesIcon />
            </IconButton>
          </span>

          <!-- Cancel Button -->
          <IconButton
            tabindex={-1}
            onclick={cancelRerolled}
          >
            <XIcon />
          </IconButton>

          <!-- Apply Button -->
          <IconButton
            active
            activeColor="primary"
            tabindex={-1}
            onclick={applyRerolled}
          >
            <CheckIcon />
          </IconButton>
        </IconButtonGroup>
      </div>
    </div>

    <!-- Rerolled Summary -->
    <div class="mt-2 sm:mt-4">
      <TextAreaInput
        fullwidth
        actionBar
        className="bg-darkbg"
        tabindex={-1}
        bind:value={rerolled}
      />
    </div>

    <!-- Rerolled Summary Translation -->
    {#if rerolledTranslation}
      <div class="mt-2 sm:mt-4">
        <div class="mb-2 text-sm text-textcolor2 sm:mb-4">
          {language.hypaV3Modal.rerolledTranslationLabel}
        </div>

        <TextAreaInput
          fullwidth
          actionBar
          className="bg-darkbg"
          readonly
          tabindex={-1}
          bind:textareaRef={summaryItemState.rerolledTranslationRef}
          bind:value={rerolledTranslation}
        />
      </div>
    {/if}
  {/if}

  <!-- Connected Messages Header -->
  <div class="mt-2 sm:mt-4">
    <div class="flex items-center justify-between">
      <button
        class="flex items-center gap-2 text-sm text-textcolor2 transition-colors risu-interactive-foreground"
        tabindex="-1"
        onclick={toggleSummaryCollapse}
      >
        {#if isCollapsed()}
          <ChevronDownIcon size={18} />
        {:else}
          <ChevronUpIcon size={18} />
        {/if}
        <span>{language.hypaV3Modal.connectedMessageCountLabel.replace(
          "{0}",
          summary.chatMemos.length.toString()
        )}</span>
      </button>

      <IconButtonGroup>
        <!-- Translate Message Button -->
        <span
          class="inline-flex"
          use:handleDualAction={{
            onMainAction: () => toggleTranslateExpandedMessage(false),
            onAlternativeAction: () => toggleTranslateExpandedMessage(true),
          }}
        >
          <IconButton tabindex={-1}>
            <LanguagesIcon />
          </IconButton>
        </span>
      </IconButtonGroup>
    </div>
  </div>

  {#if !isCollapsed()}
    <!-- Connected Message IDs -->
    <div class="flex flex-wrap gap-2 mt-2 sm:mt-4">
      {#key summary.chatMemos.length}
        {#each summary.chatMemos as chatMemo, memoIndex (chatMemo)}
          <button
            class="rounded-md border border-darkborderc bg-darkbg/40 px-2 py-1.5 text-xs text-textcolor2 transition-colors risu-interactive-surface {isMessageExpanded(
              chatMemo
            )
              ? 'ring-2 ring-borderc'
              : ''}"
            tabindex="-1"
            bind:this={summaryItemState.chatMemoRefs[memoIndex]}
            onclick={() => toggleExpandMessage(chatMemo)}
          >
            {chatMemo == null
              ? language.hypaV3Modal.connectedFirstMessageLabel
              : chatMemo}
          </button>
        {/each}
      {/key}
    </div>

    {#if expandedMessageState?.summaryIndex === summaryIndex}
      <!-- Expanded Message -->
      <div class="mt-2 sm:mt-4">
        {#await getMessageFromChatMemo(expandedMessageState.selectedChatMemo) then expandedMessage}
          {#if expandedMessage}
            <!-- Role -->
            <div class="mb-2 text-sm text-textcolor2 sm:mb-4">
              {language.hypaV3Modal.connectedMessageRoleLabel.replace(
                "{0}",
                expandedMessage.role
              )}
            </div>

            <!-- Content -->
            <TextAreaInput
              fullwidth
              actionBar
              className="bg-darkbg"
              readonly
              tabindex={-1}
              value={expandedMessage.data}
            />
          {:else}
            <span class="text-sm text-draculared"
              >{language.hypaV3Modal.connectedMessageNotFoundLabel}</span
            >
          {/if}
        {:catch error}
          <span class="text-sm text-draculared"
            >{language.hypaV3Modal.connectedMessageLoadingError.replace(
              "{0}",
              error.message
            )}</span
          >
        {/await}
      </div>

      <!-- Expanded Message Translation -->
      {#if expandedMessageState.translation}
        <div class="mt-2 sm:mt-4">
          <div class="mb-2 text-sm text-textcolor2 sm:mb-4">
            {language.hypaV3Modal.connectedMessageTranslationLabel}
          </div>

          <TextAreaInput
            fullwidth
            actionBar
            className="bg-darkbg"
            readonly
            tabindex={-1}
            bind:textareaRef={expandedMessageState.translationRef}
            bind:value={expandedMessageState.translation}
          />
        </div>
      {/if}
    {/if}
  {/if}

</div>
