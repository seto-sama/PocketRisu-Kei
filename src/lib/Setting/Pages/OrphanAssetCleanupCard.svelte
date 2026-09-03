<script lang="ts">
    import { ImageOffIcon, InfoIcon } from '@lucide/svelte'
    import { language } from 'src/lang'
    import ShAlert from 'src/lib/UI/GUI/ShAlert.svelte'
    import ShButton from 'src/lib/UI/GUI/ShButton.svelte'
    import ShLoadingDialog from 'src/lib/UI/GUI/ShLoadingDialog.svelte'
    import ShSwitch from 'src/lib/UI/GUI/ShSwitch.svelte'
    import SettingLayout from 'src/lib/Setting/Wrappers/SettingLayout.svelte'
    import { alertConfirm, notifyError, notifySuccess } from 'src/ts/alert'
    import { DBState } from 'src/ts/stores.svelte'
    import { purgeOrphanAssets, type OrphanAssetStats } from 'src/ts/storage/orphanAssets'

    let {
        orphan,
        onPurged,
    }: {
        orphan: OrphanAssetStats
        onPurged: () => void | Promise<void>
    } = $props()

    let cleaning = $state(false)

    async function cleanOrphanAssets() {
        if(!orphan.available || orphan.count === 0) return
        const confirmed = await alertConfirm(language.storageOrphanConfirm(
            orphan.count,
            orphan.totalSize,
        ))
        if(!confirmed) return

        cleaning = true
        try {
            const result = await purgeOrphanAssets()
            notifySuccess(language.storageOrphanDone(result.deleted, result.bytes))
            await onPurged()
        }
        catch(error){
            notifyError(language.storageOrphanFailed + ': ' + (error instanceof Error ? error.message : String(error)))
        }
        finally {
            cleaning = false
        }
    }
</script>

<SettingLayout variant="panel">
    <div class="flex items-baseline justify-between gap-2 mb-3 flex-wrap">
        <div class="flex items-center gap-2 text-maintext">
            <ImageOffIcon size={16} />
            <span class="font-medium">{language.storageOrphan}</span>
        </div>
        {#if orphan.available}
            <span class="text-subtext text-sm tabular-nums">
                {language.storageOrphanHeader(orphan.count, orphan.totalSize)}
            </span>
        {/if}
    </div>

    <p class="text-subtext text-sm leading-relaxed mb-2">{language.storageOrphanWhat}</p>
    <p class="text-subtext text-sm leading-relaxed mb-3">{language.storageOrphanWhen}</p>

    {#if !orphan.available}
        <ShAlert variant="default">
            {#snippet icon()}<InfoIcon />{/snippet}
            {language.storageOrphanUnavailable}
        </ShAlert>
    {/if}

    <div class="flex items-center justify-between gap-3 mb-3">
        <div class="min-w-0">
            <div class="text-maintext text-sm">{language.storageOrphanAutoClean}</div>
            <div class="text-subtext text-xs leading-relaxed">{language.storageOrphanAutoCleanDesc}</div>
        </div>
        <ShSwitch bind:checked={DBState.db.nodeOnlyAutoCleanAssets} />
    </div>

    <div class="flex justify-end">
        <ShButton
            variant="primary"
            onclick={cleanOrphanAssets}
            disabled={!orphan.available || orphan.count === 0 || cleaning}
        >
            <ImageOffIcon />
            {language.storageOrphanPurge}
        </ShButton>
    </div>
</SettingLayout>

<ShLoadingDialog open={cleaning} message={language.storageOrphanPurging} />
