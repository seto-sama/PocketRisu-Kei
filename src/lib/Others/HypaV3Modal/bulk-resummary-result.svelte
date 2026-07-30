<script lang="ts">
  import {
    LanguagesIcon,
    RefreshCw,
    CheckIcon,
    XIcon,
  } from "@lucide/svelte";
  import { language } from "src/lang";
  import type { BulkResummaryState } from "./types";
  import { handleDualAction } from "./utils";
  import IconButton from "src/lib/UI/GUI/IconButton.svelte";
  import IconButtonGroup from "src/lib/UI/GUI/IconButtonGroup.svelte";
  import TextAreaInput from "src/lib/UI/GUI/TextAreaInput.svelte";

  interface Props {
    bulkResummaryState: BulkResummaryState | null;
    title?: string;
    processingTitle?: string;
    fillHeight?: boolean;
    onToggleTranslation: (regenerate: boolean) => void;
    onReroll: () => void;
    onApply: () => void;
    onCancel: () => void;
  }

  let {
    bulkResummaryState,
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
{#if bulkResummaryState}
  <div class="{fillHeight ? 'flex-1 min-h-0' : 'shrink-0'} border-t border-darkborderc pt-4">
    <div class="flex flex-col gap-3 {fillHeight ? 'h-full min-h-0' : ''}">
      <div class="flex justify-between items-center">
        <h3 class="text-sm font-medium text-textcolor">{title}</h3>
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
              disabled={bulkResummaryState.isProcessing || !bulkResummaryState.result}
              title={language.hypaV3Modal.translate}
            >
              <LanguagesIcon />
            </IconButton>
          </span>
          
          <!-- Reroll Button -->
          <IconButton
            onclick={onReroll}
            disabled={bulkResummaryState.isProcessing}
            title={language.hypaV3Modal.retry}
          >
            <RefreshCw />
          </IconButton>
          
          <!-- Apply Button -->
          <IconButton
            active
            activeColor="primary"
            onclick={onApply}
            disabled={bulkResummaryState.isProcessing || !bulkResummaryState.result}
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
      {#if bulkResummaryState.isProcessing}
        <div class="py-4 text-center text-textcolor2">
          <RefreshCw class="mr-2 inline animate-spin" />
          {processingTitle}
        </div>
      {:else if bulkResummaryState.result}
        <TextAreaInput
          fullwidth
          actionBar
          className="bg-darkbg"
          height={fillHeight ? "full" : "32"}
          readonly
          bind:value={bulkResummaryState.result}
        />
        
        <!-- Translation Result -->
        {#if bulkResummaryState.translation}
          <div class="{fillHeight ? 'flex flex-col min-h-0 flex-1' : 'mt-3'}">
            <div class="mb-2 text-sm text-textcolor2">
              {language.hypaV3Modal.translationLabel}
            </div>
            <TextAreaInput
              fullwidth
              actionBar
              className="bg-darkbg"
              height={fillHeight ? "full" : "32"}
              readonly
              bind:value={bulkResummaryState.translation}
            />
          </div>
        {/if}
      {/if}
    </div>
  </div>
{/if}
