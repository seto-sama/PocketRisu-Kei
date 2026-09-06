<script lang="ts">
    import { DBState, selectedCharID } from "src/ts/stores.svelte";
    import { language } from "src/lang";
    import { PinIcon, PinOffIcon } from "@lucide/svelte";
    import { openPersonaList, personaSelectCallback } from "src/ts/stores.svelte";
    import Button from "../UI/components/Button.svelte";
    import { bindPersonaToCurrentChat } from "src/ts/chatBindings";

    let currentChat = $derived(DBState.db.characters[$selectedCharID]?.chats?.[DBState.db.characters[$selectedCharID]?.chatPage])

    let boundPersona = $derived.by(() => {
        const id = currentChat?.bindedPersona
        if (!id) return null
        return DBState.db.personas.find(p => p.id === id) ?? null
    })
    let displayPersona = $derived(boundPersona ?? DBState.db.personas[DBState.db.selectedPersona])
    let isPersonaBound = $derived(!!boundPersona)

    function handlePersonaBindClick() {
        personaSelectCallback.set(bindPersonaToCurrentChat)
        openPersonaList.set(true)
    }
</script>

<div class="text-[11px] text-subtext mt-4 px-1">{language.personaBindingLabel}</div>
<div class="flex gap-1 mt-1 items-stretch">
    <Button
        className={`flex-1 min-w-0 justify-start ${isPersonaBound
            ? 'border-selected text-maintext'
            : 'text-subtext opacity-75 risu-interactive-reveal'}`}
        onclick={handlePersonaBindClick}
    >
        {#if isPersonaBound}
            <PinIcon class="shrink-0" />
        {:else}
            <PinOffIcon class="shrink-0" />
        {/if}
        <span class="truncate">{displayPersona?.name ?? 'User'}</span>
        {#if displayPersona?.note}
            <span class="truncate text-xs opacity-60">({displayPersona.note})</span>
        {/if}
    </Button>
</div>
