<script lang="ts">
    // Boot-time backup reminder prompt.
    //
    // Mounted globally in App.svelte. Driven by `bootBackupPromptStore`:
    // bootstrap.ts sets the store and awaits the user's decision (proceed /
    // skip), then continues the boot sequence. The prompt disables the
    // proceed button when the estimated backup size exceeds disk free, so
    // the user can't kick off a save that the server would refuse anyway.
    import { bootBackupPromptStore } from "src/ts/stores.svelte";
    import { language } from "src/lang";
    import ShDialog from "src/lib/UI/GUI/ShDialog.svelte";
    import ShButton from "src/lib/UI/GUI/ShButton.svelte";
    import ShAlert from "src/lib/UI/GUI/ShAlert.svelte";
    import { TriangleAlertIcon } from "@lucide/svelte";

    const data = $derived($bootBackupPromptStore);

    // 90-94% → yellow warn, 95%+ → red crit. insufficient takes priority.
    const diskUsedPct = $derived(
        data && data.free != null && data.total != null && data.total > 0
            ? ((data.total - data.free) / data.total) * 100
            : null
    );
    const diskUsageLevel = $derived<'none' | 'warn' | 'crit'>(
        diskUsedPct == null ? 'none'
            : diskUsedPct >= 95 ? 'crit'
            : diskUsedPct >= 90 ? 'warn'
            : 'none'
    );

    function decide(mode: 'skip' | 'snapshot' | 'full') {
        const d = $bootBackupPromptStore;
        if (!d) return;
        bootBackupPromptStore.set(null);
        d.resolve(mode);
    }
</script>

{#if data}
    <ShDialog
        open={true}
        onOpenChange={(v) => { if (!v) decide('skip'); }}
        closeOnEscape={false}
        closeOnOutsideClick={false}
        tier="alert"
        size="default"
        footer={footerActions}
    >
        {#snippet title()}{language.backupBootPromptTitle}{/snippet}

        <div class="flex flex-col gap-2 text-textcolor2 text-sm leading-relaxed">
            {#if data.estimate != null}
                <div class="tabular-nums">{language.backupBootPromptEstimate(data.estimate)}</div>
            {/if}
            {#if data.free != null && data.total != null}
                <div class="tabular-nums">{language.backupBootPromptDisk(data.free, data.total)}</div>
            {/if}
        </div>

        {#if data.insufficient}
            <ShAlert variant="destructive" className="mt-3">
                {#snippet icon()}<TriangleAlertIcon />{/snippet}
                {language.backupServerInsufficient}
            </ShAlert>
        {:else if diskUsageLevel === 'crit' && diskUsedPct != null}
            <ShAlert variant="destructive" className="mt-3">
                {#snippet icon()}<TriangleAlertIcon />{/snippet}
                {language.storageDiskUsageHighWarning(diskUsedPct)}
            </ShAlert>
        {:else if diskUsageLevel === 'warn' && diskUsedPct != null}
            <ShAlert variant="warning" className="mt-3">
                {#snippet icon()}<TriangleAlertIcon />{/snippet}
                {language.storageDiskUsageHighWarning(diskUsedPct)}
            </ShAlert>
        {/if}
    </ShDialog>
{/if}

{#snippet footerActions()}
    <div class="flex justify-end gap-2 flex-wrap">
        <ShButton variant="outline" onclick={() => decide('skip')}>
            {language.backupBootPromptSkip}
        </ShButton>
        <ShButton variant="outline" onclick={() => decide('snapshot')}>
            {language.manualSnapshotCreate}
        </ShButton>
        <ShButton variant="primary" disabled={data?.insufficient} onclick={() => decide('full')}>
            {language.backupServerCreate}
        </ShButton>
    </div>
{/snippet}
