<script lang="ts">
    import { updatePopupStore, dismissUpdatePopup, selfUpdateProgressStore, executeSelfUpdate, type UpdateInfo, type SelfUpdateProgress } from "src/ts/update";
    import { openURL } from "src/ts/globalApi.svelte";
    import { SaveServerBackup } from "src/ts/drive/backuplocal";
    import { language } from "src/lang";
    import { ArrowUpCircleIcon, AlertTriangleIcon, DownloadIcon, CheckCircleIcon, XCircleIcon, SaveIcon } from "@lucide/svelte";
    import ProgressDialog from "../UI/components/ProgressDialog.svelte";
    import Button from "../UI/components/Button.svelte";

    const info: UpdateInfo | null = $derived($updatePopupStore);
    const progress: SelfUpdateProgress | null = $derived($selfUpdateProgressStore);

    const isUpdating = $derived(progress != null);

    const canClose = $derived(!isUpdating || progress?.step === 'done' || progress?.step === 'error');

    const title = $derived(
        isUpdating
            ? progress?.step === 'done' ? language.selfUpdateDone
                : progress?.step === 'error' ? language.selfUpdateFailed
                : language.selfUpdateInProgress
            : info ? getTitle(info.severity) : ''
    );

    $effect(() => {
        if (!info?.simulation || !isUpdating || canClose) return;
        const timer = setTimeout(() => {
            selfUpdateProgressStore.set({ step: 'done', progress: 100, message: '업데이트 완료 (시뮬레이션).' });
        }, 2000);
        return () => clearTimeout(timer);
    });

    function getTitle(severity: string): string {
        if (severity === 'required') return language.updatePopupTitleRequired
        if (severity === 'outdated') return language.updatePopupTitleOutdated
        return language.updatePopupTitle
    }

    function handleSelfUpdate() {
        if (info?.simulation) {
            selfUpdateProgressStore.set({ step: 'checking', progress: 0, message: '업데이트 정보 확인 중 (시뮬레이션)...' });
            return;
        }
        executeSelfUpdate()
    }

    function handleDone() {
        const isDone = progress?.step === 'done' && !info?.simulation
        selfUpdateProgressStore.set(null)
        dismissUpdatePopup()
        if (isDone) {
            location.reload()
        }
    }

</script>

{#if info}
    <ProgressDialog
        open={true}
        {title}
        message={progress?.message ?? ''}
        progress={progress?.step === 'downloading' ? progress.progress : null}
        icon={canClose ? statusIcon : undefined}
        footer={canClose ? footerActions : undefined}
    >
        {#if isUpdating}
            {#if progress?.step === 'done'}
                <p class="mt-2 text-sm text-subtext">{language.selfUpdateReloadHint}</p>
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
    </ProgressDialog>
{/if}

{#snippet statusIcon()}
    {#if progress?.step === 'error'}
        <span class="p-2 rounded-full bg-danger/20 shrink-0" aria-hidden="true">
            <XCircleIcon size={20} class="text-danger" />
        </span>
    {:else if progress?.step === 'done'}
        <span class="p-2 rounded-full bg-success/20 shrink-0" aria-hidden="true">
            <CheckCircleIcon size={20} class="text-success" />
        </span>
    {:else if info?.severity === 'optional'}
        <span class="p-2 rounded-full bg-success/20 shrink-0" aria-hidden="true">
            <ArrowUpCircleIcon size={20} class="text-success" />
        </span>
    {:else}
        <span class="p-2 rounded-full bg-danger/20 shrink-0" aria-hidden="true">
            <AlertTriangleIcon size={20} class="text-danger" />
        </span>
    {/if}
{/snippet}

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
