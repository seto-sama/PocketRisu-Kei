<script lang="ts">
    import { BookIcon, ImageIcon, SmileIcon } from "@lucide/svelte";
    import { hubURL, type hubType } from "src/ts/characterCards";
    import { DBState } from "src/ts/stores.svelte";
    import { parseMultilangString } from "src/ts/util";
    import ShButton from "../GUI/ShButton.svelte";
    import RealmTagList from "./RealmTagList.svelte";
    import { tooltip } from "src/ts/gui/tooltip";

    interface Props {
        onClick?: () => void;
        chara: hubType;
    }

    let { onClick = () => {}, chara }: Props = $props();
    const descriptions = $derived(parseMultilangString(chara.desc));
    const description = $derived(descriptions[DBState.db.language] ?? descriptions.en ?? descriptions.xx);

</script>


<ShButton variant="secondary" className="relative h-auto w-full flex-col items-start justify-start whitespace-normal p-4 text-left font-normal" onclick={onClick}>
    <div class="flex gap-2 w-full">
    {#if DBState.db.hideAllImages}
        <div class="w-20 min-w-20 h-20 sm:h-28 sm:w-28 rounded-md bg-darkbutton flex items-center justify-center text-textcolor2">
            <span class="text-4xl">?</span>
        </div>
    {:else}
        <img class="w-20 min-w-20 h-20 sm:h-28 sm:w-28 rounded-md object-top object-cover" alt={chara.name} src={`${hubURL}/resource/` + chara.img}>
    {/if}
    <div class="flex flex-col grow min-w-0">
        <span class="text-textcolor text-lg min-w-0 max-w-full text-ellipsis whitespace-nowrap overflow-hidden text-start">{chara.name}</span>
        <span class="text-textcolor2 text-xs min-w-0 max-w-full text-ellipsis wrap-break-word max-h-8 whitespace-nowrap overflow-hidden text-start">{description}</span>
        <RealmTagList tags={chara.tags} limit={4} className="mt-1" />
        <div class="grow"></div>
        <div class="flex flex-wrap w-full flex-row-reverse gap-1">
            {#if chara.hasEmotion}
                <span class="inline-flex text-textcolor2" use:tooltip={'This character includes emotion images'}><SmileIcon /></span>
            {/if}
            {#if chara.hasAsset}
                <span class="inline-flex text-textcolor2" use:tooltip={'This character includes additional assets'}><ImageIcon /></span>
            {/if}
            {#if chara.hasLore}
                <span class="inline-flex text-textcolor2" use:tooltip={'This character includes lorebook'}><BookIcon /></span>
            {/if}
        </div>
    </div>
</div></ShButton>
