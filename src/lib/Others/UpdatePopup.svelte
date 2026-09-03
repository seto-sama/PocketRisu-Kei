<script lang="ts">
    import { updatePopupStore, dismissUpdatePopup, selfUpdateProgressStore, executeSelfUpdate, type UpdateInfo, type SelfUpdateProgress } from "src/ts/update";
    import { openURL } from "src/ts/globalApi.svelte";
    import { SaveServerBackup } from "src/ts/drive/backuplocal";
    import { language } from "src/lang";
    import { ArrowUpCircleIcon, AlertTriangleIcon, DownloadIcon, LoaderIcon, CheckCircleIcon, XCircleIcon, SaveIcon } from "@lucide/svelte";
    import Dialog from "../UI/components/Dialog.svelte";
    import Button from "../UI/components/Button.svelte";

    const info: UpdateInfo | null = $derived($updatePopupStore);
    const progress: SelfUpdateProgress | null = $derived($selfUpdateProgressStore);

    /** True while a self-update is running (or just finished/failed) */
    const isUpdating = $derived(progress != null);

    /** Closable iff idle, or the update reached its terminal state. */
    const canClose = $derived(!isUpdating || progress?.step === 'done' || progress?.step === 'error');

    function getTitle(severity: string): string {
        if (severity === 'required') return language.updatePopupTitleRequired
        if (severity === 'outdated') return language.updatePopupTitleOutdated
        return language.updatePopupTitle
    }

    function handleSelfUpdate() {
        executeSelfUpdate()
    }

    function handleDone() {
        const isDone = progress?.step === 'done'
        selfUpdateProgressStore.set(null)
        dismissUpdatePopup()
        if (isDone) {
            location.reload()
        }
    }

    /** Dialog.onOpenChange close path — routes through handleDone when an
     *  update has finished (so reload fires) and through dismiss otherwise. */
    function handleClose() {
        if (isUpdating) handleDone()
        else dismissUpdatePopup()
    }
</script>

<!--
    Nested alerts are placed above this popup by the shared overlay stack.
    closeOnOutsideClick stays false because
    showUpdatePopupOnce() persists the dismiss before render — accidental
    backdrop clicks would silently drop the version forever. ESC stays
    blocked per branch convention.
-->
{#if info}
    <Dialog
        open={true}
        onOpenChange={(v) => { if (!v) handleClose() }}
        closable={canClose}
        closeOnEscape={false}
        closeOnOutsideClick={false}
        size="sm"
        footer={canClose ? footerActions : undefined}
    >
        {#snippet title()}
            <span class="inline-flex items-center gap-2.5">
                {#if isUpdating}
                    {#if progress?.step === 'error'}
                        <span class="p-2 rounded-full bg-danger/20" aria-hidden="true">
                            <XCircleIcon size={20} class="text-danger" />
                        </span>
                    {:else if progress?.step === 'done'}
                        <span class="p-2 rounded-full bg-success/20" aria-hidden="true">
                            <CheckCircleIcon size={20} class="text-success" />
                        </span>
                    {:else}
                        <span class="p-2 rounded-full bg-primary/20" aria-hidden="true">
                            <LoaderIcon size={20} class="text-primary animate-spin" />
                        </span>
                    {/if}
                {:else if info.severity === 'optional'}
                    <span class="p-2 rounded-full bg-success/20" aria-hidden="true">
                        <ArrowUpCircleIcon size={20} class="text-success" />
                    </span>
                {:else}
                    <span class="p-2 rounded-full bg-danger/20" aria-hidden="true">
                        <AlertTriangleIcon size={20} class="text-danger" />
                    </span>
                {/if}
                <span>
                    {#if isUpdating}
                        {progress?.step === 'done' ? language.selfUpdateDone
                            : progress?.step === 'error' ? language.selfUpdateFailed
                            : language.selfUpdateInProgress}
                    {:else}
                        {getTitle(info.severity)}
                    {/if}
                </span>
            </span>
        {/snippet}

        {#if isUpdating}
            <p class="text-sm text-subtext leading-relaxed">{progress?.message}</p>
            {#if progress?.step === 'done'}
                <p class="mt-2 text-sm text-subtext">{language.selfUpdateReloadHint}</p>
            {/if}
            {#if progress?.step === 'downloading' && progress.progress != null}
                <div class="mt-3 w-full bg-selected rounded-full h-2 overflow-hidden">
                    <div class="h-full bg-lightborderc rounded-full transition-all duration-300"
                        style="width: {progress.progress}%"></div>
                </div>
                <p class="mt-1 text-xs text-subtext text-right">{progress.progress}%</p>
            {/if}
        {:else}
            <p class="text-sm text-subtext leading-relaxed">
                {@html language.updatePopupDesc
                    .replace('{{latest}}', info.latestVersion)
                    .replace('{{current}}', info.currentVersion)}
            </p>

            {#if info.releaseName}
                <p class="mt-2 text-sm text-maintext">{info.releaseName}</p>
            {/if}

            {#if info.popupMessage}
                <div class="mt-3 text-sm text-subtext leading-relaxed whitespace-pre-line border-t border-darkborderc pt-3">
                    {info.popupMessage}
                </div>
            {/if}
        {/if}
    </Dialog>
{/if}

{#snippet footerActions()}
    {#if isUpdating}
        {#if progress?.step === 'done'}
            <Button variant="success" onclick={handleDone}>
                {language.selfUpdateReload}
            </Button>
        {:else if progress?.step === 'error'}
            <Button variant="outline" onclick={handleDone}>
                {language.close}
            </Button>
        {/if}
    {:else if info}
        <Button variant="outline" onclick={dismissUpdatePopup}>
            {language.updatePopupLater}
        </Button>
        <Button variant="outline" onclick={() => SaveServerBackup()}>
            <SaveIcon />
            {language.updatePopupBackup}
        </Button>
        {#if info.canSelfUpdate}
            <Button
                variant={info.severity === 'optional' ? 'success' : 'destructive'}
                onclick={handleSelfUpdate}
            >
                <DownloadIcon size={12} />
                {language.selfUpdateNow}
            </Button>
        {:else}
            <Button
                variant={info.severity === 'optional' ? 'success' : 'destructive'}
                onclick={() => { openURL(info.releaseUrl); dismissUpdatePopup(); }}
            >
                {language.updatePopupViewRelease}
            </Button>
        {/if}
    {/if}
{/snippet}
