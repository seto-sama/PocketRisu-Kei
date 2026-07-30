<script lang="ts">
    import { PackageIcon, Sailboat } from "@lucide/svelte";
    import { QuickSettings } from "src/ts/stores.svelte";
    import OtherBotSettings from "../Setting/Pages/OtherBotSettings.svelte";
    import AddonSettings from "../Setting/Pages/AddonSettings.svelte";
    import IconButton from "../UI/GUI/IconButton.svelte";
    import IconButtonGroup from "../UI/GUI/IconButtonGroup.svelte";
    import { language } from "src/lang";
</script>

<IconButtonGroup size="xl" className="relative bottom-2 h-8 min-h-8 w-full items-start">
    <IconButton
        active={QuickSettings.index === 0}
        aria-label={language.otherBots}
        title={language.otherBots}
        onclick={() => QuickSettings.index = 0}
    >
        <Sailboat />
    </IconButton>
    <IconButton
        active={QuickSettings.index === 1}
        aria-label={language.addons}
        title={language.addons}
        onclick={() => QuickSettings.index = 1}
    >
        <PackageIcon />
    </IconButton>
</IconButtonGroup>

<div class="relative flex flex-col text-textcolor rs-setting-cont-5">
    {#if QuickSettings.index === 0}
        <OtherBotSettings />
    {:else if QuickSettings.index === 1}
        <AddonSettings />
    {/if}
</div>
