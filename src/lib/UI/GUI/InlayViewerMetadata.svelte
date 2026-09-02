<script lang="ts">
    import { language } from 'src/lang'
    import type { InlayExplorerItem } from 'src/ts/process/files/inlays'

    interface Props {
        item: InlayExplorerItem
        characterName?: string | null
        chatName?: string | null
        characterStatus?: string | null
        chatStatus?: string | null
    }

    let {
        item,
        characterName = null,
        chatName = null,
        characterStatus = null,
        chatStatus = null,
    }: Props = $props()

    const createdAt = $derived(item.meta?.createdAt && item.meta.createdAt > 0
        ? new Date(item.meta.createdAt).toLocaleString()
        : null)
</script>

<div class="space-y-2 text-xs">
    {#if !item.hasMeta}
        <span class="risu-status-warning inline-flex rounded px-1.5 py-0.5 text-[9px] font-medium">
            {language.inlayGallery.inlayFilterMetaMissing}
        </span>
    {/if}
    <dl class="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1">
        {#if characterName || chatName || characterStatus || chatStatus}
            <dt class="text-textcolor2">{language.linkedChat}</dt>
            <dd class="flex min-w-0 items-center gap-1.5 overflow-hidden text-textcolor">
                {#if characterStatus}
                    <span class="risu-status-warning shrink-0 rounded px-1.5 py-0.5 text-[9px] font-medium">{characterStatus}</span>
                {:else if characterName}
                    <span class="truncate">{characterName}</span>
                {/if}
                {#if (characterName || characterStatus) && (chatName || chatStatus)}
                    <span class="shrink-0 text-textcolor2">/</span>
                {/if}
                {#if chatStatus}
                    <span class="risu-status-warning shrink-0 rounded px-1.5 py-0.5 text-[9px] font-medium">{chatStatus}</span>
                {:else if chatName}
                    <span class="truncate">{chatName}</span>
                {/if}
            </dd>
        {/if}
        <dt class="text-textcolor2">{language.imageInfo}</dt>
        <dd class="flex min-w-0 items-center gap-1.5 overflow-hidden text-textcolor">
            {#if createdAt}<span class="truncate">{createdAt}</span>{/if}
            {#if createdAt && (item.ext || (item.width && item.height))}
                <span class="shrink-0 text-textcolor2">/</span>
            {/if}
            <span class="shrink-0">
                {#if item.width && item.height}{item.width} × {item.height}{#if item.ext} ({item.ext.toUpperCase()}){/if}{:else}{item.ext?.toUpperCase() ?? ''}{/if}
            </span>
        </dd>
        {#if item.meta?.imageGeneration?.seed !== undefined}
            <div class="col-span-2 grid grid-cols-subgrid gap-x-3">
                <dt class="text-textcolor2">{language.seed}</dt>
                <dd class="truncate text-textcolor">{item.meta.imageGeneration.seed}</dd>
            </div>
        {/if}
    </dl>
    {#if item.meta?.imageGeneration?.prompt}
        <div class="space-y-0.5">
            <p class="text-textcolor2">{language.positivePrompt}</p>
            <p class="whitespace-pre-wrap break-words text-textcolor">{item.meta.imageGeneration.prompt}</p>
        </div>
    {/if}
    {#if item.meta?.imageGeneration?.negativePrompt}
        <div class="space-y-0.5">
            <p class="text-textcolor2">{language.negativePrompt}</p>
            <p class="whitespace-pre-wrap break-words text-textcolor">{item.meta.imageGeneration.negativePrompt}</p>
        </div>
    {/if}
</div>
