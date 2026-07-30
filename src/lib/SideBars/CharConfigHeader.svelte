<script lang="ts">
    import {
        ActivityIcon,
        BookIcon,
        Braces,
        Share2Icon,
        SmileIcon,
        UserIcon,
        Volume2Icon,
        WrenchIcon,
    } from "@lucide/svelte";
    import { language } from "src/lang";
    import { CharConfigSubMenu, selectedCharID } from "src/ts/stores.svelte";
    import { DBState } from "src/ts/stores.svelte";
    import IconButton from "src/lib/UI/GUI/IconButton.svelte";
    import IconButtonGroup from "src/lib/UI/GUI/IconButtonGroup.svelte";

    interface Props {
        devTool: boolean;
        onDevToolChange: (active: boolean) => void;
    }

    let { devTool, onDevToolChange }: Props = $props();
    const character = $derived(DBState.db.characters[$selectedCharID]);
    const canEdit = $derived(character?.type !== "character" || character.license !== "private");

    function selectSubMenu(index: number) {
        $CharConfigSubMenu = index;
        onDevToolChange(false);
    }
</script>

<IconButtonGroup size="xl" className="relative bottom-2 h-8 min-h-8 w-full items-start">
    {#if canEdit}
        <div class="flex h-8 items-start">
            <IconButton active={$CharConfigSubMenu === 0 && !devTool} onclick={() => selectSubMenu(0)}><UserIcon /></IconButton>
            <IconButton active={$CharConfigSubMenu === 1 && !devTool} onclick={() => selectSubMenu(1)}><SmileIcon /></IconButton>
            <IconButton active={$CharConfigSubMenu === 3 && !devTool} onclick={() => selectSubMenu(3)}><BookIcon /></IconButton>
            {#if character?.type === "character"}
                {#if DBState.db.ttsEnabled}
                    <IconButton active={$CharConfigSubMenu === 5 && !devTool} onclick={() => selectSubMenu(5)}><Volume2Icon /></IconButton>
                {/if}
                <IconButton active={$CharConfigSubMenu === 4 && !devTool} onclick={() => selectSubMenu(4)}><Braces /></IconButton>
            {/if}
            <IconButton active={$CharConfigSubMenu === 2 && !devTool} onclick={() => selectSubMenu(2)}><ActivityIcon /></IconButton>
            {#if character?.type === "character"}
                <IconButton active={$CharConfigSubMenu === 6 && !devTool} onclick={() => selectSubMenu(6)}><Share2Icon /></IconButton>
            {/if}
        </div>
    {/if}

    <IconButton
        className="ml-auto"
        active={devTool}
        aria-label={language.devTools}
        title={language.devTools}
        onclick={() => onDevToolChange(true)}
    >
        <WrenchIcon />
    </IconButton>
</IconButtonGroup>
