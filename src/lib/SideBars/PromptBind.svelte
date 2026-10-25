<script lang="ts">
    import { getChatBoundPromptPreset } from "src/ts/chatBindingState";
    import { getChatPage } from 'src/ts/storage/chatSelection.svelte';

    import { DBState, selectedCharID, openPresetList, presetSelectCallback } from "src/ts/stores.svelte";
    import { language } from "src/lang";
    import { changeToPreset } from "src/ts/storage/database.svelte";
    import { ChevronDownIcon, PinIcon, PinOffIcon, SlidersHorizontalIcon } from "@lucide/svelte";
    import Button from "../UI/components/Button.svelte";
    import Switch from "../UI/components/Switch.svelte";
    import Help from "../Others/Help.svelte";
    import { bindPromptPresetToCurrentChat } from "src/ts/chatBindings";

    let currentChat = $derived(DBState.db.characters[$selectedCharID]?.chats?.[getChatPage(DBState.db.characters[$selectedCharID])])

    let paramsExpanded = $state(false);
    let globalPromptParamsOn = $derived(DBState.db.modelPresetPromptParamsFirst === true);
    let promptParamsOn = $derived(globalPromptParamsOn || currentChat?.usePromptPresetParams === true);

    let boundPreset = $derived(getChatBoundPromptPreset(DBState.db, currentChat))
    let isPresetBound = $derived(boundPreset !== null)
    let displayPreset = $derived(
        isPresetBound
            ? boundPreset
            : DBState.db.botPresets.find(preset => preset.id === DBState.db.activePromptPresetId)
    )

    // Keep the active prompt preset aligned with this chat's binding.
    $effect(() => {
        if (boundPreset && DBState.db.activePromptPresetId !== boundPreset.id) {
            changeToPreset(boundPreset.id)
        }
    })

    function handlePresetBindClick() {
        presetSelectCallback.set(bindPromptPresetToCurrentChat)
        openPresetList.set(true)
    }
</script>

<div class="text-[11px] text-subtext mt-4 px-1">{language.promptBindingLabel}</div>
<div class="flex gap-1 mt-1 items-stretch">
    <Button
        className={`flex-1 min-w-0 justify-start ${isPresetBound
            ? 'border-selected text-maintext'
            : 'text-subtext opacity-75 risu-interactive-reveal'}`}
        onclick={handlePresetBindClick}
    >
        {#if isPresetBound}
            <PinIcon class="shrink-0" />
        {:else}
            <PinOffIcon class="shrink-0" />
        {/if}
        <span class="truncate">{displayPreset?.name ?? language.none}</span>
    </Button>
    <Button
        size="icon"
        variant={promptParamsOn ? 'primary' : 'default'}
        className="shrink-0"
        onclick={() => { paramsExpanded = !paramsExpanded }}
        title={language.promptPresetParamsUse}
    >
        {#if promptParamsOn}
            <SlidersHorizontalIcon />
        {:else}
            <ChevronDownIcon class={`transition-transform${paramsExpanded ? ' rotate-180' : ''}`} />
        {/if}
    </Button>
</div>
{#if paramsExpanded && currentChat}
    <div class="flex flex-col gap-1 mt-1 pl-2 border-l border-selected">
        <div class="w-full flex items-center justify-between gap-2 min-h-10 rounded-md px-1">
            <span class="min-w-0">{language.promptPresetParamsUse}<Help key="promptPresetParams" name={language.promptPresetParamsUse}/></span>
            <Switch
                className="shrink-0"
                checked={promptParamsOn}
                disabled={globalPromptParamsOn}
                onCheckedChange={(v) => { if (currentChat) currentChat.usePromptPresetParams = v }}
            />
        </div>
    </div>
{/if}
