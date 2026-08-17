<script lang="ts">
    // Inline server-backup list component (extracted from the legacy
    // serverBackupManager modal). Renders the list with restore / download /
    // delete actions but no modal chrome — embedded directly in pages.
    //
    // Restore flow forces a full page reload because the in-memory db cache
    // is replaced; download streams via streamsaver to avoid loading the
    // backup into memory.
    import { language } from "src/lang";
    import { alertConfirm, alertConfirmMulti, alertError, alertWait, alertStore, waitAlert, notifySuccess, notifyError } from "src/ts/alert";
    import { forageStorage, downloadFile } from "src/ts/globalApi.svelte";
    import { RotateCcwIcon, DownloadIcon, TrashIcon } from "@lucide/svelte";
    import SettingLayout from "src/lib/Setting/Wrappers/SettingLayout.svelte";
    import IconButton from "src/lib/UI/GUI/IconButton.svelte";
    import IconButtonGroup from "src/lib/UI/GUI/IconButtonGroup.svelte";

    interface Props {
        onChange?: () => void;
        onStatsChange?: (count: number, totalSize: number) => void;
    }
    let { onChange, onStatsChange }: Props = $props();

    interface BackupEntry {
        filename: string;
        size: number;
        createdAt: number;
    }

    let backups = $state<BackupEntry[]>([]);
    let loading = $state(true);

    function formatBytes(bytes: number): string {
        if (bytes < 1024) return `${bytes} B`;
        if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
        if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
        return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
    }

    export async function loadBackups() {
        loading = true;
        try {
            const result = await forageStorage.listServerBackups();
            backups = result.backups;
            onStatsChange?.(
                backups.length,
                backups.reduce((total, backup) => total + backup.size, 0),
            );
        } catch (error) {
            notifyError(error instanceof Error ? error.message : 'Failed to load backups');
        }
        loading = false;
    }

    async function chooseRestore(backup: BackupEntry) {
        const selected = await alertConfirmMulti(language.serverBackupRestoreMenuTitle, [
            language.serverBackupLoadBackup,
            language.serverBackupRestoreAssets,
        ]);
        if (selected === 0) {
            await restoreBackup(backup);
        } else if (selected === 1) {
            await restoreAssets(backup);
        }
    }

    async function restoreBackup(backup: BackupEntry) {
        if (!(await alertConfirm(language.backupLoadConfirm))) return;
        if (!(await alertConfirm(language.backupLoadConfirm2))) return;
        alertWait(language.serverBackupRestoring);
        try {
            const result = await forageStorage.restoreServerBackup(backup.filename, (bytes, totalBytes) => {
                if (totalBytes > 0) {
                    const pct = ((bytes / totalBytes) * 100).toFixed(1);
                    alertWait(`${language.serverBackupRestoring} (${pct}%)`);
                }
            });
            if (result.coldStorageFailed && result.coldStorageFailed > 0) {
                alertError(`Warning: ${result.coldStorageFailed} character(s) could not be restored from cold storage. The restored save may be incomplete. The app will now reload.`);
                await waitAlert();
            } else {
                alertStore.set({ type: "wait", msg: "Success, Refreshing your app." });
            }
            location.search = '';
            location.reload();
        } catch (error) {
            alertError(error instanceof Error ? error.message : 'Restore failed');
        }
    }

    async function restoreAssets(backup: BackupEntry) {
        alertWait(language.serverBackupAssetsRestoring);
        try {
            const result = await forageStorage.restoreMissingServerBackupAssets(
                backup.filename,
                (bytes, totalBytes) => {
                    if (totalBytes > 0) {
                        const pct = ((bytes / totalBytes) * 100).toFixed(1);
                        alertWait(`${language.serverBackupAssetsRestoring} (${pct}%)`);
                    }
                },
            );
            notifySuccess(language.serverBackupAssetsRestoreSuccess(
                result.assetsRestored,
                result.assetsUnavailable,
            ));
        } catch (error) {
            alertError(error instanceof Error ? error.message : 'Asset restore failed');
        }
    }

    async function downloadBackup(backup: BackupEntry) {
        alertWait(language.serverBackupDownloading);
        try {
            const response = await forageStorage.downloadServerBackup(backup.filename);
            if (response.body) {
                const streamSaver = await import('streamsaver');
                const writableStream = streamSaver.createWriteStream(backup.filename);
                const writer = writableStream.getWriter();
                const reader = response.body.getReader();
                const totalBytes = Number(response.headers.get('content-length') ?? '0');
                let downloaded = 0;
                while (true) {
                    const { done, value } = await reader.read();
                    if (done) break;
                    downloaded += value.length;
                    if (totalBytes > 0) {
                        alertWait(`${language.serverBackupDownloading} (${((downloaded / totalBytes) * 100).toFixed(1)}%)`);
                    }
                    await writer.write(value);
                }
                await writer.close();
            } else {
                await downloadFile(backup.filename, new Uint8Array(await response.arrayBuffer()));
            }
            notifySuccess('Success');
        } catch (error) {
            notifyError(error instanceof Error ? error.message : 'Download failed');
        }
    }

    async function deleteBackup(backup: BackupEntry) {
        if (!(await alertConfirm(language.serverBackupDeleteConfirm(backup.filename)))) return;
        try {
            await forageStorage.deleteServerBackup(backup.filename);
            backups = backups.filter(b => b.filename !== backup.filename);
            onStatsChange?.(
                backups.length,
                backups.reduce((total, item) => total + item.size, 0),
            );
            notifySuccess(language.serverBackupDeleteSuccess);
            onChange?.();
        } catch (error) {
            alertError(error instanceof Error ? error.message : 'Delete failed');
        }
    }

    loadBackups();
</script>

{#if loading}
    <p class="text-textcolor2 text-sm">{language.serverBackupLoading}</p>
{:else if backups.length === 0}
    <p class="text-textcolor2 text-sm">{language.serverBackupEmpty}</p>
{:else}
    <SettingLayout variant="list" scrollable className="max-h-[75vh]">
        {#each backups as backup (backup.filename)}
            <SettingLayout variant="item" className="text-textcolor">
                <div class="flex flex-col min-w-0 flex-1">
                    <span class="text-sm">{new Date(backup.createdAt).toLocaleString()}</span>
                    <span class="text-xs text-textcolor2 tabular-nums">{formatBytes(backup.size)}</span>
                </div>
                {#snippet control()}
                    <IconButtonGroup>
                    <IconButton title={language.serverBackupRestore} aria-label={language.serverBackupRestore}
                        onclick={() => chooseRestore(backup)}>
                        <RotateCcwIcon />
                    </IconButton>
                    <IconButton title={language.serverBackupDownload} aria-label={language.serverBackupDownload}
                        onclick={() => downloadBackup(backup)}>
                        <DownloadIcon />
                    </IconButton>
                    <IconButton tone="destructive" title={language.serverBackupDelete} aria-label={language.serverBackupDelete}
                        onclick={() => deleteBackup(backup)}>
                        <TrashIcon />
                    </IconButton>
                    </IconButtonGroup>
                {/snippet}
            </SettingLayout>
        {/each}
    </SettingLayout>
{/if}
