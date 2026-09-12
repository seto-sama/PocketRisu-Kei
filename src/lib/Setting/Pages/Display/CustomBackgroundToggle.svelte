<script lang="ts">
    import { language } from 'src/lang';
    import { saveImage } from 'src/ts/storage/database.svelte';
    import { getFileSrc } from 'src/ts/globalApi.svelte';
    import { DBState } from 'src/ts/stores.svelte';
    import { selectSingleImageFile } from 'src/ts/util';
    import Button from '../../../UI/components/Button.svelte';
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
        const d = await selectSingleImageFile();
        if (!d) return;
        DBState.db.customBackground = await saveImage(d.data);
    }
    function clear() {
        DBState.db.customBackground = '';
    }
</script>

<div class="flex items-center justify-between gap-3 py-3 border-t border-darkborderc">
    <div class="flex flex-col min-w-0">
        <span class="text-sm text-maintext">{language.useCustomBackground}</span>
        {#if language.help.customBackground}<p class="text-xs text-subtext mt-0.5">{language.help.customBackground}</p>{/if}
    </div>
    <div class="shrink-0 flex items-center gap-2">
        {#if hasBg && previewUrl}
            <img src={previewUrl} alt="" class="h-8 w-12 rounded object-cover border border-darkborderc" />
        {/if}
        <Button variant="outline" size="sm" onclick={pick}>
            <ImageIcon />
            {hasBg ? language.edit : language.select}
        </Button>
        {#if hasBg}
            <Button variant="destructive" size="icon-sm" onclick={clear} aria-label={language.remove}>
                <XIcon />
            </Button>
        {/if}
    </div>
</div>
