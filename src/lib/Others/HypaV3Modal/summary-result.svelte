<script lang="ts">
  import {
    LanguagesIcon,
    RefreshCwIcon,
    CheckIcon,
    XIcon,
  } from "@lucide/svelte";
  import { language } from "src/lang";
  import type { SummaryResultState } from "./types";
  import { handleDualAction } from "./utils";
  import IconButton from "src/lib/UI/GUI/IconButton.svelte";
  import IconButtonGroup from "src/lib/UI/GUI/IconButtonGroup.svelte";
  import TextAreaInput from "src/lib/UI/GUI/TextAreaInput.svelte";

  interface Props {
    summaryResultState: SummaryResultState | null;
    title?: string;
    processingTitle?: string;
    fillHeight?: boolean;
    onToggleTranslation: (regenerate: boolean) => void;
    onReroll: () => void;
    onApply: () => void;
    onCancel: () => void;
  }

  let {
    summaryResultState,
    title = language.hypaV3Modal.reSummarizeResult,
    processingTitle = language.hypaV3Modal.reSummarizing,
    fillHeight = false,
    onToggleTranslation,
    onReroll,
    onApply,
    onCancel,
  }: Props = $props();

</script>

<!-- Bulk Resummarize Result Section -->
{#if summaryResultState}
  <div class="{fillHeight ? 'flex-1 min-h-0 overflow-hidden' : 'shrink-0'} border-t border-darkborderc pt-4">
    <div class="flex flex-col gap-3 {fillHeight ? 'h-full min-h-0' : ''}">
      <div class="flex shrink-0 justify-between items-center">
        <h3 class="text-sm font-medium text-maintext">{title}</h3>
        <IconButtonGroup size="xl" style="--icon-size:16px">
          <!-- Translate Button -->
          <span
            class="inline-flex"
            use:handleDualAction={{
              onMainAction: () => onToggleTranslation(false),
              onAlternativeAction: () => onToggleTranslation(true),
            }}
          >
            <IconButton
              disabled={summaryResultState.isProcessing || !summaryResultState.result}
              title={language.hypaV3Modal.translate}
            >
              <LanguagesIcon />
            </IconButton>
          </span>
          
          <!-- Reroll Button -->
          <IconButton
            onclick={onReroll}
            disabled={summaryResultState.isProcessing}
            title={language.hypaV3Modal.retry}
          >
            <RefreshCwIcon />
          </IconButton>
          
          <!-- Apply Button -->
          <IconButton
            active
            activeColor="primary"
            onclick={onApply}
            disabled={summaryResultState.isProcessing || !summaryResultState.result}
            title={language.apply}
          >
            <CheckIcon />
          </IconButton>
          
          <!-- Cancel Button -->
          <IconButton
            onclick={onCancel}
            title={language.cancel}
          >
            <XIcon />
          </IconButton>
        </IconButtonGroup>
      </div>
      
      <!-- Result Content -->
      {#if summaryResultState.isProcessing}
        <div class="py-4 text-center text-subtext">
          <RefreshCwIcon class="mr-2 inline animate-spin" />
          {processingTitle}
        </div>
      {:else if summaryResultState.result}
        <div
          class={fillHeight
            ? `grid min-h-0 flex-1 gap-3 ${summaryResultState.translation ? "grid-rows-2" : "grid-rows-1"}`
            : ""}
        >
          <div class={fillHeight ? "min-h-0" : ""}>
            <TextAreaInput
              fullwidth
              actionBar
              className="bg-darkbg"
              height={fillHeight ? "full" : "32"}
              readonly
              bind:value={summaryResultState.result}
            />
          </div>

          <!-- Translation Result -->
          {#if summaryResultState.translation}
            <div class="{fillHeight ? 'flex min-h-0 flex-col' : 'mt-3'}">
              <div class="mb-2 shrink-0 text-sm text-subtext">
                {language.hypaV3Modal.translationLabel}
              </div>
              <div class={fillHeight ? "min-h-0 flex-1" : ""}>
                <TextAreaInput
                  fullwidth
                  actionBar
                  className="bg-darkbg"
                  height={fillHeight ? "full" : "32"}
                  readonly
                  bind:value={summaryResultState.translation}
                />
              </div>
            </div>
          {/if}
        </div>
      {/if}
    </div>
  </div>
{/if}
