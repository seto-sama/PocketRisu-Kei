<script lang="ts">
    // Inline server-backup list component (extracted from the legacy
    // serverBackupManager modal). Renders the list with restore / download /
    // delete actions but no modal chrome — embedded directly in pages.
    //
    // Restore flow forces a full page reload because the in-memory db cache
    // is replaced; download streams via streamsaver to avoid loading the
    // backup into memory.
    import { getCurrentLocale, language } from "src/lang";
    import { alertConfirm, alertConfirmMulti, alertError, alertWait, alertStore, waitAlert, notifySuccess, notifyError } from "src/ts/alert";
    import { forageStorage, downloadFile } from "src/ts/globalApi.svelte";
    import { RotateCcwIcon, DownloadIcon, TrashIcon } from "@lucide/svelte";
    import SettingLayout from "src/lib/Setting/Wrappers/SettingLayout.svelte";
    import IconButton from "src/lib/UI/GUI/IconButton.svelte";
    import IconButtonGroup from "src/lib/UI/GUI/IconButtonGroup.svelte";
    import InlineRenameAction from "src/lib/UI/GUI/InlineRenameAction.svelte";
    import ShButton from "src/lib/UI/GUI/ShButton.svelte";
    import BackupNoteEditor from "src/lib/Setting/BackupNoteEditor.svelte";
    import { updateBackupNote } from "src/ts/drive/backupNotes";

    const PAGE_SIZE = 20;

    interface Props {
        onChange?: () => void;
        onStatsChange?: (count: number, totalSize: number) => void;
    }
    let { onChange, onStatsChange }: Props = $props();

    interface BackupEntry {
        filename: string;
        size: number;
        createdAt: number;
        note: string;
    }

    let backups = $state<BackupEntry[]>([]);
    let loading = $state(true);
    let shown = $state(PAGE_SIZE);
    let noteEditorOpen = $state(false);
    let noteEditorBackup = $state<BackupEntry | null>(null);
    const displayedBackups = $derived(backups.slice(0, shown));
    const remaining = $derived(Math.max(0, backups.length - shown));

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
            backups = result.backups.map(backup => ({ ...backup, note: backup.note ?? '' }));
            shown = PAGE_SIZE;
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

    function openNoteEditor(backup: BackupEntry) {
        noteEditorBackup = backup;
        noteEditorOpen = true;
    }

    async function saveNote(value: string) {
        if (!noteEditorBackup) return;
        noteEditorBackup.note = await updateBackupNote('server', noteEditorBackup.filename, value);
        backups = [...backups];
    }

    loadBackups();
</script>

{#if loading}
    <p class="text-subtext text-sm">{language.serverBackupLoading}</p>
{:else if backups.length === 0}
    <p class="text-subtext text-sm">{language.serverBackupEmpty}</p>
{:else}
    <SettingLayout variant="list">
        {#each displayedBackups as backup (backup.filename)}
            <SettingLayout variant="item" inlineRenameRow className="text-maintext">
                <div class="flex flex-col min-w-0 flex-1">
                    <span class="truncate text-sm text-maintext">{backup.note || language.backupNoteEmpty}</span>
                    <span class="flex flex-wrap items-center gap-x-1 text-xs text-subtext tabular-nums">
                        <span>{new Date(backup.createdAt).toLocaleString(getCurrentLocale())}</span>
                        <span aria-hidden="true">·</span>
                        <span>{formatBytes(backup.size)}</span>
                    </span>
                </div>
                {#snippet control()}
                    <IconButtonGroup>
                        <InlineRenameAction title={language.backupNoteEdit} onclick={() => openNoteEditor(backup)} />
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
    {#if remaining > 0}
        <div class="flex justify-center mt-3">
            <ShButton variant="outline" size="sm" onclick={() => shown += PAGE_SIZE}>
                {language.systemLogsLoadMore}
            </ShButton>
        </div>
    {/if}
{/if}

<BackupNoteEditor
    bind:open={noteEditorOpen}
    value={noteEditorBackup?.note ?? ''}
    onSave={saveNote}
/>
