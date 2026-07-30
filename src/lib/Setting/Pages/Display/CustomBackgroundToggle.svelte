<script lang="ts">
    import { language } from 'src/lang';
    import { saveImage } from 'src/ts/storage/database.svelte';
    import { getFileSrc } from 'src/ts/globalApi.svelte';
    import { DBState } from 'src/ts/stores.svelte';
    import { selectSingleFile } from 'src/ts/util';
    import ShButton from 'src/lib/UI/GUI/ShButton.svelte';
    import { ImageIcon, XIcon } from '@lucide/svelte';

    const hasBg = $derived(!!DBState.db.customBackground && DBState.db.customBackground !== '-');

    let previewUrl = $state('');
    $effect(() => {
        const bg = DBState.db.customBackground;
        if (bg && bg.startsWith('assets/')) {
            getFileSrc(bg).then((u) => (previewUrl = u || ''));
        } else {
            previewUrl = '';
        }
    });

    async function pick() {
        const d = await selectSingleFile(['png', 'webp', 'gif', 'jpg', 'jpeg']);
        if (!d) return;
        DBState.db.customBackground = await saveImage(d.data);
    }
    function clear() {
        DBState.db.customBackground = '';
    }
</script>

<div class="flex items-center justify-between gap-3 py-3 border-t border-darkborderc">
    <div class="flex flex-col min-w-0">
        <span class="text-sm text-textcolor">{language.useCustomBackground}</span>
        {#if language.help.customBackground}<p class="text-xs text-textcolor2 mt-0.5">{language.help.customBackground}</p>{/if}
    </div>
    <div class="shrink-0 flex items-center gap-2">
        {#if hasBg && previewUrl}
            <img src={previewUrl} alt="" class="h-8 w-12 rounded object-cover border border-darkborderc" />
        {/if}
        <ShButton variant="outline" size="sm" onclick={pick}>
            <ImageIcon />
            {hasBg ? language.edit : language.select}
        </ShButton>
        {#if hasBg}
            <ShButton variant="destructive" size="icon-sm" onclick={clear} aria-label={language.remove}>
                <XIcon />
            </ShButton>
        {/if}
    </div>
</div>
