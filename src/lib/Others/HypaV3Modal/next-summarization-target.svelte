<script lang="ts">
  import type { SerializableHypaV3Data } from "src/ts/process/memory/hypav3";
  import { language } from "src/lang";
  import { getFirstMessage, getNextSummarizationTarget } from "./utils";
  import TextAreaInput from "src/lib/UI/GUI/TextAreaInput.svelte";

  interface Props {
    hypaV3Data: SerializableHypaV3Data;
  }

  let { hypaV3Data }: Props = $props();
  let nextTarget = $derived(getNextSummarizationTarget(hypaV3Data));
</script>

<!-- Next Summarization Target -->
<div class="mt-2 sm:mt-4">
  {#await nextTarget then nextMessage}
    {#if nextMessage}
      {@const chatId =
        nextMessage.chatId === "first"
          ? language.hypaV3Modal.nextSummarizationFirstMessageLabel
          : nextMessage.chatId == null
            ? language.hypaV3Modal.nextSummarizationNoMessageIdLabel
            : nextMessage.chatId}
      <div class="mb-2 text-sm text-textcolor2 sm:mb-4">
        {language.hypaV3Modal.nextSummarizationLabel.replace("{0}", chatId)}
      </div>

      <TextAreaInput
        fullwidth
        actionBar
        className="bg-darkbg"
        readonly
        value={nextMessage.data}
      />
    {:else}
      <span class="text-sm text-draculared"
        >{language.hypaV3Modal.nextSummarizationNoMessagesFoundLabel}</span
      >
    {/if}
  {:catch error}
    <span class="text-sm text-draculared"
      >{language.hypaV3Modal.nextSummarizationLoadingError.replace(
        "{0}",
        error.message
      )}</span
    >
  {/await}
</div>

<div class="mt-2 sm:mt-4">
  <!-- No First Message -->
  {#if !getFirstMessage()}
    <span class="text-sm text-draculared"
      >{language.hypaV3Modal.emptySelectedFirstMessageLabel}</span
    >
  {/if}
</div>
