<script lang="ts">
    import { DBState, selectedCharID } from "src/ts/stores.svelte";
    import { language } from "src/lang";
    import { ChevronDownIcon } from "@lucide/svelte";
    import ModelPresetList from "../UI/ModelPresetList.svelte";
    import ShSwitch from "../UI/GUI/ShSwitch.svelte";
    import ShButton from "../UI/GUI/ShButton.svelte";
    import { emptyModelBinding } from "src/ts/preset/types";

    let currentChat = $derived(
        DBState.db.characters[$selectedCharID]?.chats?.[DBState.db.characters[$selectedCharID]?.chatPage]
    );

    let auxExpanded = $state(false);

    // Seed an old chat that predates model-preset bindings from the global
    // default, or start with an empty binding when no default is configured.
    // Normalize every field to a defined primitive — bind:value / bind:checked on
    // a $bindable rejects undefined (Svelte props_invalid_value).
    function ensureBinding() {
        if (!currentChat) return;
        if (!currentChat.modelBinding) {
            const def = DBState.db.defaultModelBinding;
            currentChat.modelBinding = def ? structuredClone($state.snapshot(def)) : emptyModelBinding();
        }
        const b = currentChat.modelBinding;
        b.main ??= '';
        b.sub ??= '';
        b.separateAux ??= false;
        b.aux ??= { memory: '', emotion: '', translate: '', otherAx: '' };
        b.aux.memory ??= '';
        b.aux.emotion ??= '';
        b.aux.translate ??= '';
        b.aux.otherAx ??= '';
    }

    // All chats use model-preset mode; legacy mode fields are ignored.
    $effect(() => {
        if (currentChat) ensureBinding();
    });
</script>

<div class="flex flex-col gap-1 mt-4">
    <div class="text-[11px] text-textcolor2 px-1">{language.modelPresetBindingTitle}</div>

    {#if currentChat?.modelBinding}
        <ModelPresetList showConfigure warnIfEmpty bind:value={currentChat.modelBinding.main} />
        <div class="flex gap-1 items-stretch">
            <div class="flex-1 min-w-0">
                <ModelPresetList showConfigure warnIfEmpty bind:value={currentChat.modelBinding.sub} />
            </div>
            <ShButton size="icon" className="shrink-0" onclick={() => { auxExpanded = !auxExpanded }} title={language.seperateModelsForAxModels}>
                <ChevronDownIcon class={`transition-transform${auxExpanded ? ' rotate-180' : ''}`} />
            </ShButton>
        </div>
        {#if auxExpanded}
            <div class="flex flex-col gap-1 mt-1 pl-2 border-l border-selected">
                <div class="w-full flex items-center justify-between gap-2 min-h-10 rounded-md px-1">
                    <span class="min-w-0">{language.seperateModelsForAxModels}</span>
                    <ShSwitch className="shrink-0" bind:checked={currentChat.modelBinding.separateAux} />
                </div>
                <div class="text-[11px] text-textcolor2 px-1">{language.axModelMemory}</div>
                <ModelPresetList showConfigure blankable disabled={!currentChat.modelBinding.separateAux} bind:value={currentChat.modelBinding.aux.memory} />
                <div class="text-[11px] text-textcolor2 px-1">{language.axModelTranslate}</div>
                <ModelPresetList showConfigure blankable disabled={!currentChat.modelBinding.separateAux} bind:value={currentChat.modelBinding.aux.translate} />
                <div class="text-[11px] text-textcolor2 px-1">{language.axModelEmotion}</div>
                <ModelPresetList showConfigure blankable disabled={!currentChat.modelBinding.separateAux} bind:value={currentChat.modelBinding.aux.emotion} />
                <div class="text-[11px] text-textcolor2 px-1">{language.axModelOther}</div>
                <ModelPresetList showConfigure blankable disabled={!currentChat.modelBinding.separateAux} bind:value={currentChat.modelBinding.aux.otherAx} />
            </div>
        {/if}
    {/if}
</div>
