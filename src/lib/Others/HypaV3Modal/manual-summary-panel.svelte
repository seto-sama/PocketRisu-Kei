<script lang="ts">
  import { ChevronDownIcon, ScrollTextIcon } from "@lucide/svelte";
  import { language } from "src/lang";
  import { alertNormalWait } from "src/ts/alert";
  import type { OpenAIChat } from "src/ts/process/index.svelte";
  import {
    summarize,
    type SerializableHypaV3Data,
  } from "src/ts/process/memory/hypav3";
  import { type Message } from "src/ts/storage/database.svelte";
  import { DBState, selectedCharID } from "src/ts/stores.svelte";
  import { translateHTML } from "src/ts/translator/translator";
  import BulkResummaryResult from "./bulk-resummary-result.svelte";
  import type { BulkResummaryState } from "./types";
  import {
    getFirstMessage,
    processHypaV3Message,
    processMessageCBS,
  } from "./utils";
  import ShInput from "src/lib/UI/GUI/ShInput.svelte";
  import ShButton from "src/lib/UI/GUI/ShButton.svelte";
  import CheckInput from "src/lib/UI/GUI/CheckInput.svelte";

  type ManualSummaryMessage = {
    index: number;
    chatMemo?: string;
    role: Message["role"];
    data: string;
    displayData: string;
    disabled: boolean;
  };

  interface Props {
    enabled: boolean;
    hypaV3Data: SerializableHypaV3Data;
    onApplied: () => void;
  }

  let {
    enabled = $bindable(),
    hypaV3Data,
    onApplied,
  }: Props = $props();

  let manualSummarySearch = $state("");
  let manualSelectedMessageIndices = $state(new Set<number>());
  let manualSummaryState = $state<BulkResummaryState | null>(null);
  let manualMessageTranslations = $state<Record<number, string>>({});
  let manualMessageTranslating = $state(new Set<number>());

  $effect(() => {
    if (!enabled) {
      resetManualSummaryState(true);
      manualSummarySearch = "";
    }
  });

  function getManualSummaryCutoffIndex(): number {
    const char = DBState.db.characters[$selectedCharID];
    const chat = char.chats[char.chatPage];
    const lastSummary = hypaV3Data?.summaries?.at(-1);
    const lastChatMemo = lastSummary?.chatMemos?.at(-1);

    if (!lastSummary) return -2;
    if (lastChatMemo == null) return -1;

    const lastIndex = chat.message.findIndex((message) => message.chatId === lastChatMemo);
    return lastIndex === -1 ? -2 : lastIndex;
  }

  function getManualSummaryMessages(): ManualSummaryMessage[] {
    const char = DBState.db.characters[$selectedCharID];
    const chat = char.chats[char.chatPage];
    const messages: ManualSummaryMessage[] = [];
    const firstMessage = getFirstMessage();
    const cutoffIndex = getManualSummaryCutoffIndex();

    if (firstMessage && -1 > cutoffIndex) {
      const message = processMessageCBS(
        { role: "char", data: firstMessage },
        -1,
        true
      );
      messages.push({
        index: -1,
        role: "char",
        data: firstMessage,
        displayData: message.data,
        disabled: false,
      });
    }

    chat.message.forEach((message, index) => {
      if (index <= cutoffIndex) return;
      const cbsProcessedMessage = processMessageCBS(message, index);

      messages.push({
        index,
        chatMemo: message.chatId,
        role: message.role,
        data: message.data,
        displayData: cbsProcessedMessage.data,
        disabled: !message.chatId,
      });
    });

    return messages;
  }

  function getFilteredManualSummaryMessages(): ManualSummaryMessage[] {
    const query = manualSummarySearch.trim().toLowerCase();
    const messages = getManualSummaryMessages();

    if (!query) return messages;

    return messages.filter((message) =>
      message.index.toString().includes(query) ||
      message.role.toLowerCase().includes(query) ||
      (message.chatMemo ?? "").toLowerCase().includes(query) ||
      message.displayData.toLowerCase().includes(query)
    );
  }

  function getSortedSelectedManualSummaryMessages(): ManualSummaryMessage[] {
    return getManualSummaryMessages()
      .filter((message) => manualSelectedMessageIndices.has(message.index) && !message.disabled)
      .sort((a, b) => a.index - b.index);
  }

  function resetManualSummaryState(clearSelection: boolean = false) {
    manualSummaryState = null;
    manualMessageTranslations = {};
    manualMessageTranslating = new Set();

    if (clearSelection) {
      manualSelectedMessageIndices = new Set();
    }
  }

  function getManualSummarySelectedLabel(): string {
    const indices = manualSummaryState?.selectedIndices ?? [];
    const indexText = indices.map((index) => `#${index}`).join(", ");

    return language.hypaV3Modal.manualSummarizeSelectedMessages.replace("{0}", indexText);
  }

  function handleToggleManualMessageSelection(message: ManualSummaryMessage) {
    if (message.disabled || manualSummaryState?.isProcessing) return;

    const newSelection = new Set(manualSelectedMessageIndices);
    if (newSelection.has(message.index)) {
      newSelection.delete(message.index);
    } else {
      newSelection.add(message.index);
    }
    manualSelectedMessageIndices = newSelection;
  }

  async function toggleManualMessageTranslation(message: ManualSummaryMessage, regenerate: boolean = false) {
    if (manualMessageTranslating.has(message.index)) return;

    if (manualMessageTranslations[message.index]) {
      const { [message.index]: _, ...rest } = manualMessageTranslations;
      manualMessageTranslations = rest;
      return;
    }

    manualMessageTranslating = new Set([...manualMessageTranslating, message.index]);
    manualMessageTranslations = {
      ...manualMessageTranslations,
      [message.index]: "Loading...",
    };

    try {
      const result = await translateHTML(message.displayData, false, "", -1, regenerate);
      manualMessageTranslations = {
        ...manualMessageTranslations,
        [message.index]: result,
      };
    } catch (error) {
      manualMessageTranslations = {
        ...manualMessageTranslations,
        [message.index]: `Translation failed: ${error}`,
      };
    } finally {
      const newTranslating = new Set(manualMessageTranslating);
      newTranslating.delete(message.index);
      manualMessageTranslating = newTranslating;
    }
  }

  async function buildManualSummaryInput(): Promise<{ oaiMessages: OpenAIChat[]; chatMemos: string[]; selectedIndices: number[] }> {
    const shouldProcess = DBState.db.hypaV3Presets?.[DBState.db.hypaV3PresetId]?.settings?.processRegexScript ?? false;
    const selectedMessages = getSortedSelectedManualSummaryMessages();
    const processedMessages: Message[] = [];

    for (const message of selectedMessages) {
      const rawMessage: Message = {
        role: message.role,
        data: message.data,
        chatId: message.chatMemo ?? undefined,
      };

      processedMessages.push(await processHypaV3Message(
        rawMessage,
        message.index,
        shouldProcess,
        message.index === -1
      ));
    }

    return {
      oaiMessages: processedMessages.map((message) => ({
        role: (message.role === "char" ? "assistant" : message.role) as OpenAIChat["role"],
        content: message.data,
      })),
      chatMemos: selectedMessages.map((message) => message.chatMemo) as string[],
      selectedIndices: selectedMessages.map((message) => message.index),
    };
  }

  async function summarizeManualSelected() {
    if (manualSelectedMessageIndices.size === 0) {
      await alertNormalWait(language.hypaV3Modal.manualSummarizeSelectAtLeastOne);
      return;
    }

    try {
      const { oaiMessages, chatMemos, selectedIndices } = await buildManualSummaryInput();

      if (oaiMessages.length === 0) {
        await alertNormalWait(language.hypaV3Modal.manualSummarizeSelectAtLeastOne);
        return;
      }

      manualMessageTranslations = {};
      manualMessageTranslating = new Set();

      manualSummaryState = {
        isProcessing: true,
        result: null,
        selectedIndices,
        mergedChatMemos: chatMemos,
        isTranslating: false,
        translation: null,
      };

      const result = await summarize(oaiMessages);

      manualSummaryState = {
        ...manualSummaryState,
        isProcessing: false,
        result,
      };
    } catch (error) {
      console.error("Manual summarize failed:", error);
      manualSummaryState = null;
      await alertNormalWait(`Manual summarize failed: ${error.message || error}`);
    }
  }

  async function rerollManualSummary() {
    if (!manualSummaryState) return;

    try {
      const { oaiMessages, chatMemos, selectedIndices } = await buildManualSummaryInput();

      manualSummaryState = {
        ...manualSummaryState,
        isProcessing: true,
        result: null,
        selectedIndices,
        mergedChatMemos: chatMemos,
        isTranslating: false,
        translation: null,
      };

      const result = await summarize(oaiMessages);

      manualSummaryState = {
        ...manualSummaryState,
        isProcessing: false,
        result,
      };
    } catch (error) {
      console.error("Manual summarize retry failed:", error);
      manualSummaryState = null;
      await alertNormalWait(`Manual summarize retry failed: ${error.message || error}`);
    }
  }

  function applyManualSummary() {
    if (!manualSummaryState || !manualSummaryState.result) return;

    hypaV3Data.summaries.push({
      text: manualSummaryState.result,
      chatMemos: manualSummaryState.mergedChatMemos,
      isImportant: false,
      categoryId: undefined,
    });

    resetManualSummaryState(true);
    enabled = false;
    onApplied();
  }

  function cancelManualSummary() {
    resetManualSummaryState();
  }

  async function toggleManualSummaryTranslation(regenerate: boolean = false) {
    if (!manualSummaryState || !manualSummaryState.result) return;
    if (manualSummaryState.isTranslating) return;

    if (manualSummaryState.translation) {
      manualSummaryState.translation = null;
      return;
    }

    manualSummaryState.isTranslating = true;
    manualSummaryState.translation = "Loading...";

    try {
      const result = await translateHTML(manualSummaryState.result, false, "", -1, regenerate);
      manualSummaryState.translation = result;
    } catch (error) {
      manualSummaryState.translation = `Translation failed: ${error}`;
    } finally {
      manualSummaryState.isTranslating = false;
    }
  }
</script>

{#if enabled}
  <div class="flex flex-col gap-2 sm:gap-4 {manualSummaryState ? 'shrink-0 overflow-hidden' : 'min-h-0 flex-1 overflow-hidden'}" tabindex="-1">
    {#if manualSummaryState}
      <div class="pb-2 text-xs text-textcolor2">
        {getManualSummarySelectedLabel()}
      </div>
    {:else}
      <div class="flex flex-col gap-3 min-h-0 flex-1">
        <div class="flex flex-col gap-2 sm:flex-row sm:items-center">
          <ShInput
            placeholder={language.hypaV3Modal.manualSummarizeSearchPlaceholder}
            bind:value={manualSummarySearch}
          />
          <ShButton
            variant="primary"
            className="w-full sm:w-24"
            disabled={manualSummaryState?.isProcessing || manualSelectedMessageIndices.size === 0}
            onclick={summarizeManualSelected}
          >
            {language.hypaV3Modal.manualSummarizeGenerate}
          </ShButton>
        </div>

        <div class="text-xs text-textcolor2">
          {language.hypaV3Modal.manualSummarizeSelectedCount.replace("{0}", manualSelectedMessageIndices.size.toString())}
        </div>

        {#each [getFilteredManualSummaryMessages()] as filteredManualMessages}
          {#if filteredManualMessages.length > 0}
            <div class="flex min-h-0 flex-1 flex-col divide-y divide-darkborderc/50 overflow-hidden overflow-y-auto rounded-md border border-darkborderc bg-bgcolor/50">
              {#each filteredManualMessages as message (message.index)}
                <details class="group" class:opacity-50={message.disabled}>
                  <summary class="flex cursor-pointer list-none items-center gap-2 px-3 py-2 risu-interactive-surface">
                    <CheckInput
                      card
                      check={manualSelectedMessageIndices.has(message.index)}
                      hiddenName
                      margin={false}
                      name={`#${message.index}`}
                      onChange={() => {
                        handleToggleManualMessageSelection(message);
                      }}
                    />
                    <span class="w-10 shrink-0 text-xs text-textcolor2">#{message.index}</span>
                    <span class="w-16 shrink-0 text-xs text-textcolor2">{message.role}</span>
                    <span class="min-w-0 flex-1 truncate text-sm text-textcolor">{message.displayData}</span>
                    <ChevronDownIcon size={16} class="shrink-0 text-textcolor2 transition-transform group-open:rotate-180" />
                  </summary>
                  <div class="bg-darkbg/40 p-3">
                    {#if message.disabled}
                      <div class="mb-2 text-xs text-draculared">{language.hypaV3Modal.manualSummarizeNoMessageId}</div>
                    {/if}
                    <div class="flex flex-wrap gap-2 mb-2">
                      <ShButton
                        size="xs"
                        variant="outline"
                        disabled={message.disabled || manualSummaryState?.isProcessing}
                        onclick={() => handleToggleManualMessageSelection(message)}
                      >
                        {manualSelectedMessageIndices.has(message.index) ? language.cancel : language.select}
                      </ShButton>
                      <ShButton
                        size="xs"
                        variant="outline"
                        disabled={manualMessageTranslating.has(message.index)}
                        onclick={() => toggleManualMessageTranslation(message)}
                      >
                        {manualMessageTranslations[message.index] ? language.cancel : language.hypaV3Modal.translate}
                      </ShButton>
                    </div>
                    <pre class="whitespace-pre-wrap break-all rounded-md border border-darkborderc bg-bgcolor/50 p-2 text-xs text-textcolor">{manualMessageTranslations[message.index] ?? message.displayData}</pre>
                    {#if manualMessageTranslations[message.index]}
                      <div class="mt-2 text-xs text-textcolor2">{language.hypaV3Modal.translationLabel}</div>
                    {/if}
                  </div>
                </details>
              {/each}
            </div>
          {:else}
            <div class="flex flex-col items-center justify-center rounded-md border border-darkborderc bg-bgcolor/50 py-16 text-center">
              <ScrollTextIcon size={48} class="mb-3 text-textcolor2 opacity-50" />
              <div class="mb-1 font-medium text-textcolor">{language.hypaV3Modal.manualSummarizeNoMessages}</div>
            </div>
          {/if}
        {/each}
      </div>
    {/if}
  </div>

  <BulkResummaryResult
    bulkResummaryState={manualSummaryState}
    title={language.hypaV3Modal.manualSummarizeResult}
    processingTitle={language.hypaV3Modal.manualSummarizing}
    fillHeight={enabled}
    onToggleTranslation={toggleManualSummaryTranslation}
    onReroll={rerollManualSummary}
    onApply={applyManualSummary}
    onCancel={cancelManualSummary}
  />
{/if}
