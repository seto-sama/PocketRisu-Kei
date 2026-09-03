<script lang="ts">
    import { XIcon } from "@lucide/svelte";
    import { language } from "../../lang";
    import { DBState } from 'src/ts/stores.svelte';
    import OverlayPortal from "../UI/GUI/OverlayPortal.svelte";

    interface Props {
        close?: () => void;
    }

    let { close = () => {} }: Props = $props();
</script>

<OverlayPortal>
<div class="risu-modal-backdrop risu-layer-overlay flex justify-center items-center">
    <div class="bg-darkbg p-4 break-any rounded-md flex flex-col max-w-3xl w-96 max-h-full overflow-y-auto">
        <div class="flex items-center text-maintext mb-4">
            <h2 class="mt-0 mb-0 font-bold">{language.longTermMemory} {language.presets}</h2>
            <div class="grow flex justify-end">
                <button class="text-subtext risu-interactive-accent mr-2 cursor-pointer items-center" onclick={close}>
                    <XIcon size={20}/>
                </button>
            </div>
        </div>
        {#each DBState.db.hypaV3Presets as preset, i}
            <button onclick={() => {
                DBState.db.hypaV3PresetId = i
                close()
            }} class="flex items-center text-maintext border-t-1 border-solid border-0 border-darkborderc p-2 cursor-pointer" class:bg-selected={i === DBState.db.hypaV3PresetId}>
                <span class="overflow-x-auto whitespace-nowrap w-full text-left">
                    <span class="font-medium">{preset.name}</span>
                </span>
            </button>
        {/each}
    </div>
</div>
</OverlayPortal>

<style>
    .break-any{
        word-break: normal;
        overflow-wrap: anywhere;
    }
</style>
