<script lang="ts">
  import { ChevronDownIcon, ScrollTextIcon } from "@lucide/svelte";
  import { SvelteSet } from "svelte/reactivity";
  import { getChatPage } from 'src/ts/storage/chatSelection.svelte';

  import { language } from "src/lang";
  import { alertNormalWait } from "src/ts/alert";
  import type { OpenAIChat } from "src/ts/process/index.svelte";
  import {
    getCurrentHypaV3Preset,
    summarize,
    type SerializableHypaV3Data,
  } from "src/ts/process/memory/hypav3";
  import { type Message } from "src/ts/storage/database.svelte";
  import { DBState, selectedCharID } from "src/ts/stores.svelte";
  import { translateHTML } from "src/ts/translator/translator";
  import SummaryResult from "./summary-result.svelte";
  import type { SummaryResultState } from "./types";
  import {
    getFirstMessage,
    processHypaV3Message,
    processMessageCBS,
    translateChatMessage,
  } from "./utils";
  import Input from "../../UI/components/Input.svelte";
  import Button from "../../UI/components/Button.svelte";
  import Checkbox from "../../UI/components/Checkbox.svelte";

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
    summarySignal: AbortSignal;
    onRequestStatusActivate: () => void;
    onApplied: () => void;
  }

  let {
    enabled = $bindable(),
    hypaV3Data,
    summarySignal,
    onRequestStatusActivate,
    onApplied,
  }: Props = $props();

  let manualSummarySearch = $state("");
  const manualSelectedMessageIndices = new SvelteSet<number>();
  let manualSummaryState = $state<SummaryResultState | null>(null);
  let manualMessageTranslations = $state<Record<number, string>>({});
  const manualMessageTranslating = new SvelteSet<number>();

  $effect(() => {
    if (!enabled) {
      resetManualSummaryState(true);
      manualSummarySearch = "";
    }
  });

  // Messages after the last summary: -1 also lists the greeting, -2 lists everything.
  function getManualSummaryCutoffIndex(messages: Message[]): number {
    const lastSummary = hypaV3Data.summaries.at(-1);
    if (!lastSummary) return -2;

    const lastChatMemo = lastSummary.chatMemos.at(-1);
    if (lastChatMemo == null) return -1;

    const lastIndex = messages.findIndex((message) => message.chatId === lastChatMemo);
    return lastIndex === -1 ? -2 : lastIndex;
  }

  const manualMessages = $derived.by((): ManualSummaryMessage[] => {
    const char = DBState.db.characters[$selectedCharID];
    const chatMessages = char.chats[getChatPage(char)].message;
    const cutoffIndex = getManualSummaryCutoffIndex(chatMessages);
    const firstMessage = getFirstMessage();
    const messages: ManualSummaryMessage[] = [];

    if (firstMessage && cutoffIndex < -1) {
      messages.push({
        index: -1,
        role: "char",
        data: firstMessage,
        displayData: processMessageCBS({ role: "char", data: firstMessage }, -1).data,
        disabled: false,
      });
    }

    chatMessages.forEach((message, index) => {
      if (index <= cutoffIndex) return;
      messages.push({
        index,
        chatMemo: message.chatId,
        role: message.role,
        data: message.data,
        displayData: processMessageCBS(message, index).data,
        disabled: !message.chatId,
      });
    });

    return messages;
  });

  const filteredManualMessages = $derived.by(() => {
    const query = manualSummarySearch.trim().toLowerCase();
    if (!query) return manualMessages;

    return manualMessages.filter((message) =>
      message.index.toString().includes(query) ||
      message.role.toLowerCase().includes(query) ||
      (message.chatMemo ?? "").toLowerCase().includes(query) ||
      message.displayData.toLowerCase().includes(query)
    );
  });

  function resetManualSummaryState(clearSelection: boolean = false) {
    manualSummaryState = null;
    manualMessageTranslations = {};
    manualMessageTranslating.clear();
    if (clearSelection) manualSelectedMessageIndices.clear();
  }

  function getManualSummarySelectedLabel(): string {
    const indexText = (manualSummaryState?.selectedIndices ?? []).map((index) => `#${index}`).join(", ");
    return language.hypaV3Modal.manualSummarizeSelectedMessages.replace("{0}", indexText);
  }

  function handleToggleManualMessageSelection(message: ManualSummaryMessage) {
    if (message.disabled || manualSummaryState?.isProcessing) return;

    if (!manualSelectedMessageIndices.delete(message.index)) {
      manualSelectedMessageIndices.add(message.index);
    }
  }

  async function toggleManualMessageTranslation(message: ManualSummaryMessage) {
    if (manualMessageTranslating.has(message.index)) return;

    if (manualMessageTranslations[message.index]) {
      delete manualMessageTranslations[message.index];
      return;
    }

    manualMessageTranslating.add(message.index);
    manualMessageTranslations[message.index] = language.loading;

    try {
      manualMessageTranslations[message.index] = await translateChatMessage(
        message,
        message.index,
        message.displayData,
        false
      );
    } catch (error) {
      manualMessageTranslations[message.index] = `Translation failed: ${error}`;
    } finally {
      manualMessageTranslating.delete(message.index);
    }
  }

  async function buildManualSummaryInput() {
    const shouldProcess = getCurrentHypaV3Preset().settings.processRegexScript;
    const selectedMessages = manualMessages
      .filter((message) => manualSelectedMessageIndices.has(message.index) && !message.disabled);
    const oaiMessages: OpenAIChat[] = [];

    for (const message of selectedMessages) {
      const processed = await processHypaV3Message(
        { role: message.role, data: message.data, chatId: message.chatMemo },
        message.index,
        shouldProcess
      );
      oaiMessages.push({
        role: processed.role === "char" ? "assistant" : processed.role,
        content: processed.data,
      });
    }

    return {
      oaiMessages,
      chatMemos: selectedMessages.map((message) => message.chatMemo ?? null),
      selectedIndices: selectedMessages.map((message) => message.index),
    };
  }

  async function runManualSummary(failureLabel: string) {
    try {
      const { oaiMessages, chatMemos, selectedIndices } = await buildManualSummaryInput();

      if (oaiMessages.length === 0) {
        await alertNormalWait(language.hypaV3Modal.manualSummarizeSelectAtLeastOne);
        return;
      }

      manualSummaryState = {
        isProcessing: true,
        result: null,
        selectedIndices,
        mergedChatMemos: chatMemos,
        isTranslating: false,
        translation: null,
      };

      const result = await summarize(
        oaiMessages,
        false,
        { signal: summarySignal, onRequestStatusActivate },
      );

      manualSummaryState = { ...manualSummaryState, isProcessing: false, result };
    } catch (error) {
      if (summarySignal.aborted) return;
      console.error(`${failureLabel}:`, error);
      manualSummaryState = null;
      await alertNormalWait(`${failureLabel}: ${error?.message || error}`);
    }
  }

  async function summarizeManualSelected() {
    manualMessageTranslations = {};
    manualMessageTranslating.clear();
    await runManualSummary("Manual summarize failed");
  }

  async function rerollManualSummary() {
    if (!manualSummaryState) return;
    await runManualSummary("Manual summarize retry failed");
  }

  function applyManualSummary() {
    if (!manualSummaryState?.result) return;

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

  async function toggleManualSummaryTranslation(regenerate: boolean) {
    const state = manualSummaryState;
    if (!state?.result || state.isTranslating) return;

    if (state.translation) {
      state.translation = null;
      return;
    }

    state.isTranslating = true;
    state.translation = language.loading;

    try {
      state.translation = await translateHTML(state.result, false, "", -1, regenerate);
    } catch (error) {
      state.translation = `Translation failed: ${error}`;
    } finally {
      state.isTranslating = false;
    }
  }
</script>

{#if enabled}
  <div class="flex flex-col gap-2 sm:gap-4 {manualSummaryState ? 'shrink-0 overflow-hidden' : 'min-h-0 flex-1 overflow-hidden'}" tabindex="-1">
    {#if manualSummaryState}
      <div class="pb-2 text-xs text-subtext">
        {getManualSummarySelectedLabel()}
      </div>
    {:else}
      <div class="flex flex-col gap-3 min-h-0 flex-1">
        <div class="flex flex-col gap-2 sm:flex-row sm:items-center">
          <Input
            placeholder={language.hypaV3Modal.manualSummarizeSearchPlaceholder}
            bind:value={manualSummarySearch}
          />
          <Button
            variant="primary"
            className="w-full sm:w-24"
            disabled={manualSummaryState?.isProcessing || manualSelectedMessageIndices.size === 0}
            onclick={summarizeManualSelected}
          >
            {language.hypaV3Modal.manualSummarizeGenerate}
          </Button>
        </div>

        <div class="text-xs text-subtext">
          {language.hypaV3Modal.manualSummarizeSelectedCount.replace("{0}", manualSelectedMessageIndices.size.toString())}
        </div>

        {#if filteredManualMessages.length > 0}
          <div class="flex min-h-0 flex-1 flex-col divide-y divide-darkborderc/50 overflow-hidden overflow-y-auto rounded-md border border-darkborderc bg-lightbg/50">
            {#each filteredManualMessages as message (message.index)}
              <details class="group" class:opacity-50={message.disabled}>
                <summary class="flex cursor-pointer list-none items-center gap-2 px-3 py-2 risu-interactive-surface">
                  <Checkbox
                    check={manualSelectedMessageIndices.has(message.index)}
                    hiddenName
                    margin={false}
                    name={`#${message.index}`}
                    onChange={() => {
                      handleToggleManualMessageSelection(message);
                    }}
                  />
                  <span class="w-10 shrink-0 text-xs text-subtext">#{message.index}</span>
                  <span class="w-10 shrink-0 text-xs text-subtext">{message.role}</span>
                  <span class="min-w-0 flex-1 truncate text-sm text-maintext">{message.displayData}</span>
                  <ChevronDownIcon size={16} class="shrink-0 text-subtext transition-transform group-open:rotate-180" />
                </summary>
                <div class="bg-darkbg/40 p-3">
                  {#if message.disabled}
                    <div class="mb-2 text-xs text-danger">{language.hypaV3Modal.manualSummarizeNoMessageId}</div>
                  {/if}
                  <div class="flex flex-wrap gap-2 mb-2">
                    <Button
                      size="xs"
                      variant="outline"
                      disabled={message.disabled || manualSummaryState?.isProcessing}
                      onclick={() => handleToggleManualMessageSelection(message)}
                    >
                      {manualSelectedMessageIndices.has(message.index) ? language.cancel : language.select}
                    </Button>
                    <Button
                      size="xs"
                      variant="outline"
                      disabled={manualMessageTranslating.has(message.index)}
                      onclick={() => toggleManualMessageTranslation(message)}
                    >
                      {manualMessageTranslations[message.index] ? language.cancel : language.hypaV3Modal.translate}
                    </Button>
                  </div>
                  <pre class="whitespace-pre-wrap break-all rounded-md border border-darkborderc bg-lightbg/50 p-2 text-xs text-maintext">{manualMessageTranslations[message.index] ?? message.displayData}</pre>
                  {#if manualMessageTranslations[message.index]}
                    <div class="mt-2 text-xs text-subtext">{language.hypaV3Modal.translationLabel}</div>
                  {/if}
                </div>
              </details>
            {/each}
          </div>
        {:else}
          <div class="flex flex-col items-center justify-center rounded-md border border-darkborderc bg-lightbg/50 py-16 text-center">
            <ScrollTextIcon size={48} class="mb-3 text-subtext opacity-50" />
            <div class="mb-1 font-medium text-maintext">{language.hypaV3Modal.manualSummarizeNoMessages}</div>
          </div>
        {/if}
      </div>
    {/if}
  </div>

  <SummaryResult
    summaryResultState={manualSummaryState}
    title={language.hypaV3Modal.manualSummarizeResult}
    processingTitle={language.hypaV3Modal.manualSummarizing}
    fillHeight={enabled}
    onToggleTranslation={toggleManualSummaryTranslation}
    onReroll={rerollManualSummary}
    onApply={applyManualSummary}
    onCancel={cancelManualSummary}
  />
{/if}
