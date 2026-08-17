<script lang="ts">
    // System → Backups tab. Single home for snapshot management, full server
    // backups, local backup actions, and migration-style import/export tools.
    import ShButton from 'src/lib/UI/GUI/ShButton.svelte'
    import ShAlert from 'src/lib/UI/GUI/ShAlert.svelte'
    import ShDialog from 'src/lib/UI/GUI/ShDialog.svelte'
    import ShInput from 'src/lib/UI/GUI/ShInput.svelte'
    import ServerBackupList from 'src/lib/Setting/ServerBackupList.svelte'
    import SettingRowLayout from 'src/lib/Setting/Wrappers/SettingRowLayout.svelte'
    import SettingLayout from 'src/lib/Setting/Wrappers/SettingLayout.svelte'
    import SettingRenderer from 'src/lib/Setting/SettingRenderer.svelte'
    import type { SettingItem } from 'src/ts/setting/types'
    import {
        CameraIcon,
        SaveIcon,
        DownloadIcon,
        UploadIcon,
        RotateCcwIcon,
        FolderIcon,
        TriangleAlertIcon,
        TrashIcon,
        DatabaseIcon,
        TruckIcon,
    } from '@lucide/svelte'
    import { alertConfirm, alertError, alertWait, notifyError, notifySuccess } from 'src/ts/alert'
    import { forageStorage } from 'src/ts/globalApi.svelte'
    import { getSyncClientId } from 'src/ts/storage/nodeStorage'
    import { language } from 'src/lang'
    import {
        LoadLocalBackup,
        SaveLocalBackup,
        SaveLocalBackupForUpstream,
        SaveManualSnapshot,
        SavePartialLocalBackup,
        SaveServerBackup,
    } from 'src/ts/drive/backuplocal'
    import { exportAsDataset } from 'src/ts/storage/exportAsDataset'

    // ── Types ────────────────────────────────────────────────────────────────
    interface Snapshot { key: string; size: number; timestamp: number | null }
    interface ManualSnapshot { filename: string; size: number; timestamp: number | null }
    interface BackupPathInfo { path: string; default: string; isDefault: boolean }
    interface SnapshotLimits {
        maxCount: number
        maxBytes: number
        currentCount: number
        currentBytes: number
        logicalBytes: number
        bounds: { minCount: number; maxCount: number; minBytes: number; maxBytes: number }
        defaults: { count: number; bytes: number }
    }

    // ── State ────────────────────────────────────────────────────────────────
    let snapshots = $state<Snapshot[]>([])
    let manualSnapshots = $state<ManualSnapshot[]>([])
    let initialLoaded = $state(false)
    let snapshotLoading = $state(false)
    let manualSnapshotLoading = $state(false)
    let snapshotError = $state<string | null>(null)

    let pathInfo = $state<BackupPathInfo | null>(null)
    let pathDialogOpen = $state(false)
    let pathDraft = $state('')
    let pathDialogError = $state<string | null>(null)
    let pathDialogBusy = $state(false)

    let backupListEl = $state<ServerBackupList | undefined>(undefined)
    let serverBackupSummary = $state<{ count: number; totalSize: number } | null>(null)
    let backupSaving = $state(false)
    let manualSnapshotSaving = $state(false)

    let limits = $state<SnapshotLimits | null>(null)
    let limitsDialogOpen = $state(false)
    // ShInput is string-typed; we parse in submitLimits.
    let limitsDraftCount = $state('20')
    let limitsDraftMB = $state('500')
    let limitsDialogError = $state<string | null>(null)
    let limitsDialogBusy = $state(false)

    let bootReminder = $state(false)
    let scheduleSaving = $state(false)
    let scheduleEnabled = $state(false)
    let scheduleServerDays = $state(0)
    let scheduleSnapshotDays = $state(0)
    const backupScheduleTarget = {
        get bootReminder() { return bootReminder },
        set bootReminder(value: boolean) { bootReminder = value; void saveBootReminder(value) },
        get enabled() { return scheduleEnabled },
        set enabled(value: boolean) { setScheduleEnabled(value) },
        get serverDays() { return scheduleServerDays },
        set serverDays(value: number) { scheduleServerDays = value },
        get snapshotDays() { return scheduleSnapshotDays },
        set snapshotDays(value: number) { scheduleSnapshotDays = value },
    }

    const scheduleServerItem: SettingItem = {
        id: 'backup.schedule.server',
        type: 'number',
        fallbackLabel: language.backupScheduleServer,
        bindPath: 'serverDays',
        condition: () => scheduleEnabled,
        options: { min: 0, max: 365, suffix: language.backupScheduleDaysSuffix, disabled: () => scheduleSaving, onCommit: (value) => saveBackupSchedule({ serverDays: value }) },
    }
    const scheduleSnapshotItem: SettingItem = {
        id: 'backup.schedule.snapshot',
        type: 'number',
        fallbackLabel: language.backupScheduleSnapshot,
        bindPath: 'snapshotDays',
        condition: () => scheduleEnabled,
        options: { min: 0, max: 365, suffix: language.backupScheduleDaysSuffix, disabled: () => scheduleSaving, onCommit: (value) => saveBackupSchedule({ snapshotDays: value }) },
    }
    const backupNowItem = {
        id: 'backup.create.now',
        type: 'button' as const,
        fallbackLabel: language.backupCreateNow,
    }
    const bootReminderItem: SettingItem = {
        id: 'backup.boot.reminder',
        type: 'check' as const,
        fallbackLabel: language.backupBootReminder,
        helpKey: 'bootBackupReminder' as const,
        bindPath: 'bootReminder',
    }
    const scheduleToggleItem: SettingItem = {
        id: 'backup.schedule.enabled',
        type: 'check' as const,
        fallbackLabel: language.backupScheduleEnabled,
        helpKey: 'autoBackupSchedule' as const,
        bindPath: 'enabled',
        options: { disabled: () => scheduleSaving },
    }
    const backupScheduleItems = [bootReminderItem, scheduleToggleItem, scheduleServerItem, scheduleSnapshotItem]

    // Stats subset for warnings — fetched alongside snapshots/limits.
    // Uses backupDisk (the backup destination) rather than save/ — the user
    // may have pointed backupsDir at a different mount/external drive, in
    // which case save/'s free space is irrelevant for the backup guard.
    let diskFree = $state<number | null>(null)
    let diskTotal = $state<number | null>(null)
    let estimatedBackupSize = $state<number | null>(null)

    const diskUsedPct = $derived(
        diskFree != null && diskTotal != null && diskTotal > 0
            ? ((diskTotal - diskFree) / diskTotal) * 100
            : null
    )
    // 90-94% → yellow warn, 95%+ → red crit.
    const diskUsageLevel = $derived<'none' | 'warn' | 'crit'>(
        diskUsedPct == null ? 'none'
            : diskUsedPct >= 95 ? 'crit'
            : diskUsedPct >= 90 ? 'warn'
            : 'none'
    )
    const insufficientForBackup = $derived(
        estimatedBackupSize != null && diskFree != null && estimatedBackupSize > diskFree
    )

    // ── Format helpers ───────────────────────────────────────────────────────
    function fmtBytes(n: number): string {
        if (n < 1024) return `${n} B`
        if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
        if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`
        return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`
    }

    // ── Snapshots ────────────────────────────────────────────────────────────
    async function loadSnapshots() {
        snapshotLoading = true
        snapshotError = null
        try {
            const auth = await forageStorage.createAuth()
            const res = await fetch('/api/db/snapshots', { headers: { 'risu-auth': auth } })
            if (!res.ok) throw new Error(`HTTP ${res.status}`)
            const json = await res.json()
            snapshots = json.snapshots ?? []
        } catch (err) {
            snapshotError = err instanceof Error ? err.message : String(err)
        } finally {
            snapshotLoading = false
        }
    }

    async function loadManualSnapshots() {
        manualSnapshotLoading = true
        try {
            const auth = await forageStorage.createAuth()
            const res = await fetch('/api/db/manual-snapshots', { headers: { 'risu-auth': auth } })
            if (!res.ok) throw new Error(`HTTP ${res.status}`)
            const json = await res.json()
            manualSnapshots = json.snapshots ?? []
        } catch (err) {
            snapshotError = err instanceof Error ? err.message : String(err)
        } finally {
            manualSnapshotLoading = false
        }
    }

    async function deleteSnapshot(snap: Snapshot) {
        const when = snap.timestamp ? new Date(snap.timestamp).toLocaleString() : snap.key
        if (!(await alertConfirm(language.backupSnapshotDeleteConfirm(when)))) return
        try {
            const auth = await forageStorage.createAuth()
            const url = '/api/db/snapshots?key=' + encodeURIComponent(snap.key)
            const res = await fetch(url, { method: 'DELETE', headers: { 'risu-auth': auth, 'x-sync-client-id': getSyncClientId() } })
            if (!res.ok) {
                const json = await res.json().catch(() => ({}))
                throw new Error(json?.error || `HTTP ${res.status}`)
            }
            notifySuccess(language.backupSnapshotDeleted)
            await Promise.all([loadSnapshots(), loadLimits()])
        } catch (err) {
            alertError(language.backupSnapshotDeleteFailed + ': ' + (err instanceof Error ? err.message : String(err)))
        }
    }

    async function deleteManualSnapshot(snap: ManualSnapshot) {
        const when = snap.timestamp ? new Date(snap.timestamp).toLocaleString() : snap.filename
        if (!(await alertConfirm(language.backupSnapshotDeleteConfirm(when)))) return
        try {
            const auth = await forageStorage.createAuth()
            const url = '/api/db/manual-snapshots?filename=' + encodeURIComponent(snap.filename)
            const res = await fetch(url, { method: 'DELETE', headers: { 'risu-auth': auth, 'x-sync-client-id': getSyncClientId() } })
            if (!res.ok) {
                const json = await res.json().catch(() => ({}))
                throw new Error(json?.error || `HTTP ${res.status}`)
            }
            notifySuccess(language.backupSnapshotDeleted)
            await loadManualSnapshots()
        } catch (err) {
            alertError(language.backupSnapshotDeleteFailed + ': ' + (err instanceof Error ? err.message : String(err)))
        }
    }

    async function restoreSnapshot(snap: Snapshot) {
        if (!(await alertConfirm(language.backupLoadConfirm))) return
        if (!(await alertConfirm(language.backupLoadConfirm2))) return
        alertWait(language.serverBackupRestoring)
        try {
            // Server-side atomic restore: copies snapshot blob → live blob,
            // invalidates caches, rebuilds chat store. Avoids the race where
            // a client-side setDatabase + reload could lose data because the
            // debounced save hadn't flushed yet.
            const auth = await forageStorage.createAuth()
            const res = await fetch('/api/db/snapshots/restore', {
                method: 'POST',
                headers: { 'risu-auth': auth, 'x-sync-client-id': getSyncClientId(), 'content-type': 'application/json' },
                body: JSON.stringify({ key: snap.key }),
            })
            const json = await res.json().catch(() => ({}))
            if (!res.ok) throw new Error(json?.error || `HTTP ${res.status}`)
            notifySuccess('Loaded backup')
            location.search = ''
            location.reload()
        } catch (err) {
            alertError(err instanceof Error ? err.message : String(err))
        }
    }

    async function restoreManualSnapshot(snap: ManualSnapshot) {
        if (!(await alertConfirm(language.backupLoadConfirm))) return
        if (!(await alertConfirm(language.backupLoadConfirm2))) return
        alertWait(language.serverBackupRestoring)
        try {
            const auth = await forageStorage.createAuth()
            const res = await fetch('/api/db/manual-snapshots/restore', {
                method: 'POST',
                headers: { 'risu-auth': auth, 'x-sync-client-id': getSyncClientId(), 'content-type': 'application/json' },
                body: JSON.stringify({ filename: snap.filename }),
            })
            const json = await res.json().catch(() => ({}))
            if (!res.ok) throw new Error(json?.error || `HTTP ${res.status}`)
            notifySuccess('Loaded backup')
            location.search = ''
            location.reload()
        } catch (err) {
            alertError(err instanceof Error ? err.message : String(err))
        }
    }

    // ── Snapshot limits ──────────────────────────────────────────────────────
    async function loadLimits() {
        try {
            const auth = await forageStorage.createAuth()
            const res = await fetch('/api/db/snapshots/limits', { headers: { 'risu-auth': auth } })
            if (!res.ok) throw new Error(`HTTP ${res.status}`)
            limits = await res.json()
        } catch (err) {
            console.error('[Snapshot limits]', err)
        }
    }

    function openLimitsDialog() {
        if (!limits) return
        limitsDraftCount = String(limits.maxCount)
        limitsDraftMB = String(Math.round(limits.maxBytes / 1024 / 1024))
        limitsDialogError = null
        limitsDialogOpen = true
    }

    async function submitLimits() {
        if (!limits) return
        const c = Math.floor(Number(limitsDraftCount))
        const mb = Math.floor(Number(limitsDraftMB))
        const minC = limits.bounds.minCount
        const maxC = limits.bounds.maxCount
        const minMB = Math.round(limits.bounds.minBytes / 1024 / 1024)
        const maxMB = Math.round(limits.bounds.maxBytes / 1024 / 1024)
        if (!Number.isFinite(c) || c < minC || c > maxC) {
            limitsDialogError = language.backupSnapshotLimitsCountRange(minC, maxC)
            return
        }
        if (!Number.isFinite(mb) || mb < minMB || mb > maxMB) {
            limitsDialogError = language.backupSnapshotLimitsBytesRange(minMB, maxMB)
            return
        }
        limitsDialogBusy = true
        limitsDialogError = null
        try {
            const auth = await forageStorage.createAuth()
            const res = await fetch('/api/db/snapshots/limits', {
                method: 'PUT',
                headers: { 'risu-auth': auth, 'x-sync-client-id': getSyncClientId(), 'content-type': 'application/json' },
                body: JSON.stringify({ maxCount: c, maxBytes: mb * 1024 * 1024 }),
            })
            const json = await res.json().catch(() => ({}))
            if (!res.ok) {
                limitsDialogError = json?.error || `HTTP ${res.status}`
                return
            }
            limitsDialogOpen = false
            notifySuccess(language.backupSnapshotLimitsSuccess(json.removed ?? 0))
            await Promise.all([loadLimits(), loadSnapshots()])
        } catch (err) {
            limitsDialogError = err instanceof Error ? err.message : String(err)
        } finally {
            limitsDialogBusy = false
        }
    }

    // ── Backup path ──────────────────────────────────────────────────────────
    async function loadPath() {
        try {
            const auth = await forageStorage.createAuth()
            const res = await fetch('/api/backup/server/path', { headers: { 'risu-auth': auth } })
            if (!res.ok) throw new Error(`HTTP ${res.status}`)
            pathInfo = await res.json()
        } catch (err) {
            // Non-fatal — path display will show '—'.
            console.error('[Backup path]', err)
        }
    }

    function openPathDialog() {
        pathDraft = pathInfo?.path ?? ''
        pathDialogError = null
        pathDialogOpen = true
    }

    async function submitPathChange() {
        const trimmed = pathDraft.trim()
        if (!trimmed) {
            pathDialogError = language.backupServerPath
            return
        }
        pathDialogBusy = true
        pathDialogError = null
        try {
            const auth = await forageStorage.createAuth()
            const res = await fetch('/api/backup/server/path', {
                method: 'PUT',
                headers: { 'risu-auth': auth, 'x-sync-client-id': getSyncClientId(), 'content-type': 'application/json' },
                body: JSON.stringify({ path: trimmed }),
            })
            const json = await res.json().catch(() => ({}))
            if (!res.ok) {
                pathDialogError = json?.error || `HTTP ${res.status}`
                return
            }
            pathInfo = json
            pathDialogOpen = false
            notifySuccess(language.backupServerPathSuccess)
            // Refresh backup list since the dir changed (now empty unless user moved files).
            backupListEl?.loadBackups()
            loadManualSnapshots()
        } catch (err) {
            pathDialogError = err instanceof Error ? err.message : String(err)
        } finally {
            pathDialogBusy = false
        }
    }

    // ── Stats (for disk warnings + insufficient guard) ──────────────────────
    async function loadStats() {
        try {
            const auth = await forageStorage.createAuth()
            const res = await fetch('/api/db/stats', { headers: { 'risu-auth': auth } })
            if (!res.ok) return
            const json = await res.json()
            // Prefer backupDisk (mounts to actual backup destination); fall
            // back to disk for older servers that don't yet expose it.
            const d = json?.backupDisk ?? json?.disk
            if (typeof d?.free === 'number') diskFree = d.free
            if (typeof d?.total === 'number') diskTotal = d.total
            if (typeof json?.estimatedBackupSize === 'number') estimatedBackupSize = json.estimatedBackupSize
        } catch { /* non-fatal */ }
    }

    // ── Boot reminder ────────────────────────────────────────────────────────
    async function loadBootReminder() {
        try {
            const auth = await forageStorage.createAuth()
            const res = await fetch('/api/backup/boot-reminder', { headers: { 'risu-auth': auth } })
            if (!res.ok) throw new Error(`HTTP ${res.status}`)
            const json = await res.json()
            bootReminder = !!json.enabled
        } catch (err) {
            console.error('[Boot reminder]', err)
        }
    }

    async function saveBootReminder(next: boolean) {
        try {
            const auth = await forageStorage.createAuth()
            const res = await fetch('/api/backup/boot-reminder', {
                method: 'PUT',
                headers: { 'risu-auth': auth, 'x-sync-client-id': getSyncClientId(), 'content-type': 'application/json' },
                body: JSON.stringify({ enabled: next }),
            })
            if (!res.ok) throw new Error(`HTTP ${res.status}`)
            notifySuccess(next ? language.backupBootReminderToggledOn : language.backupBootReminderToggledOff)
        } catch (err) {
            // Optimistic update revert on PUT failure.
            bootReminder = !next
            notifyError('Failed to save: ' + (err instanceof Error ? err.message : String(err)))
        }
    }

    // ── Automatic backup schedule ──────────────────────────────────────────
    async function loadBackupSchedule() {
        try {
            const auth = await forageStorage.createAuth()
            const res = await fetch('/api/backup/schedule', { headers: { 'risu-auth': auth } })
            if (!res.ok) throw new Error(`HTTP ${res.status}`)
            const json = await res.json()
            scheduleEnabled = !!json?.enabled
            scheduleServerDays = Number(json?.serverDays ?? 0)
            scheduleSnapshotDays = Number(json?.snapshotDays ?? 0)
        } catch (err) {
            console.error('[Backup schedule]', err)
        }
    }

    function normalizeScheduleDays(value: number) {
        const days = Math.floor(Number(value))
        if (!Number.isFinite(days) || days < 0) {
            return 0
        }
        if (days > 365) {
            return 365
        }
        return days
    }

    async function saveBackupSchedule(next?: { enabled?: boolean; serverDays?: number; snapshotDays?: number }) {
        const enabled = next?.enabled ?? scheduleEnabled
        const serverDays = normalizeScheduleDays(next?.serverDays ?? scheduleServerDays)
        const snapshotDays = normalizeScheduleDays(next?.snapshotDays ?? scheduleSnapshotDays)
        scheduleServerDays = serverDays
        scheduleSnapshotDays = snapshotDays
        scheduleSaving = true
        try {
            const auth = await forageStorage.createAuth()
            const res = await fetch('/api/backup/schedule', {
                method: 'PUT',
                headers: { 'risu-auth': auth, 'x-sync-client-id': getSyncClientId(), 'content-type': 'application/json' },
                body: JSON.stringify({ enabled, serverDays, snapshotDays }),
            })
            const json = await res.json().catch(() => ({}))
            if (!res.ok) throw new Error(json?.error || `HTTP ${res.status}`)
            scheduleEnabled = !!json.enabled
            scheduleServerDays = Number(json.serverDays ?? serverDays)
            scheduleSnapshotDays = Number(json.snapshotDays ?? snapshotDays)
            notifySuccess(language.backupScheduleSuccess)
        } catch (err) {
            notifyError(language.backupScheduleFailed + ': ' + (err instanceof Error ? err.message : String(err)))
        } finally {
            scheduleSaving = false
        }
    }

    function setScheduleEnabled(next: boolean) {
        scheduleEnabled = next
        saveBackupSchedule({ enabled: next })
    }

    // ── Backup creation actions ─────────────────────────────────────────────
    async function createManualSnapshot() {
        manualSnapshotSaving = true
        try {
            const result = await SaveManualSnapshot()
            if (result) {
                await Promise.all([loadManualSnapshots(), loadStats()])
            }
        } finally {
            manualSnapshotSaving = false
        }
    }

    async function createServerBackup() {
        if (!(await alertConfirm(language.backupConfirm))) return
        backupSaving = true
        try {
            await SaveServerBackup()
            backupListEl?.loadBackups()
        } finally {
            backupSaving = false
        }
    }

    async function downloadLocal() {
        if (!(await alertConfirm(language.backupConfirm))) return
        SaveLocalBackup()
    }

    async function restoreFromLocalFile() {
        if (!(await alertConfirm(language.backupLoadConfirm))) return
        if (!(await alertConfirm(language.backupLoadConfirm2))) return
        LoadLocalBackup()
    }

    async function downloadUpstreamLocal() {
        if (!(await alertConfirm(language.saveBackupForUpstreamConfirm))) return
        SaveLocalBackupForUpstream()
    }

    async function restoreFromUpstreamLocalFile() {
        if (!(await alertConfirm(language.backupLoadConfirm))) return
        if (!(await alertConfirm(language.backupLoadConfirm2))) return
        LoadLocalBackup()
    }

    async function loadInitialData() {
        await Promise.all([
            loadSnapshots(),
            loadManualSnapshots(),
            loadPath(),
            loadLimits(),
            loadBootReminder(),
            loadBackupSchedule(),
            loadStats(),
        ])
        initialLoaded = true
    }

    $effect(() => {
        loadInitialData()
    })
</script>

<p class="text-textcolor2 text-sm mb-4">{language.backupTabDesc}</p>

{#if initialLoaded}
<!-- Backup creation section ──────────────────────────────────────────────── -->
<SettingLayout variant="panel">
    <div class="flex items-center justify-between gap-2 mb-3 flex-wrap">
        <div class="flex items-center gap-2 text-textcolor">
            <DatabaseIcon size={16} />
            <span class="font-medium">{language.backupCreateSection}</span>
        </div>
    </div>

    {#if insufficientForBackup}
        <ShAlert variant="destructive" className="mb-3">
            {#snippet icon()}<TriangleAlertIcon />{/snippet}
            {language.backupServerInsufficient}
        </ShAlert>
    {:else if diskUsageLevel === 'crit' && diskUsedPct != null}
        <ShAlert variant="destructive" className="mb-3">
            {#snippet icon()}<TriangleAlertIcon />{/snippet}
            {language.storageDiskUsageHighWarning(diskUsedPct)}
        </ShAlert>
    {:else if diskUsageLevel === 'warn' && diskUsedPct != null}
        <ShAlert variant="warning" className="mb-3">
            {#snippet icon()}<TriangleAlertIcon />{/snippet}
            {language.storageDiskUsageHighWarning(diskUsedPct)}
        </ShAlert>
    {/if}

    <div class="mb-3 [&>*:first-child]:border-t-0">
        <SettingRowLayout item={backupNowItem}>
            {#snippet control()}
                <div class="flex items-center gap-2 flex-wrap justify-end">
                    <ShButton variant="outline" size="sm" onclick={createManualSnapshot} disabled={manualSnapshotSaving}>
                        <CameraIcon />
                        {language.manualSnapshotCreate}
                    </ShButton>
                    <ShButton variant="primary" size="sm" onclick={createServerBackup} disabled={backupSaving || insufficientForBackup}>
                        <SaveIcon />
                        {language.backupServerCreate}
                    </ShButton>
                </div>
            {/snippet}
        </SettingRowLayout>
        <div class="border-t border-darkborderc">
            <SettingRenderer items={backupScheduleItems} target={backupScheduleTarget} layout="row" />
        </div>
    </div>

    <!-- Path control -->
    <div class="w-full flex items-center gap-2 p-2 border border-darkborderc/50 rounded-md bg-bgcolor/50">
        <FolderIcon size={12} class="text-textcolor2 shrink-0" />
        <span class="text-textcolor2 text-xs shrink-0">{language.backupServerPath}:</span>
        <span class="text-textcolor text-xs font-mono truncate flex-1 min-w-0">
            {pathInfo?.path ?? '—'}
        </span>
        {#if pathInfo?.isDefault}
            <span class="text-textcolor2 text-xs shrink-0 opacity-60">({language.backupServerPathDefault})</span>
        {/if}
        <ShButton variant="outline" size="sm" onclick={openPathDialog}>
            {language.backupServerPathChange}
        </ShButton>
    </div>
</SettingLayout>

<!-- Server backup section ────────────────────────────────────────────────── -->
<SettingLayout variant="panel">
    <div class="flex items-center justify-between gap-2 mb-3 flex-wrap">
        <div class="flex items-center gap-2 text-textcolor">
            <SaveIcon size={16} />
            <span class="font-medium">{language.backupServer}</span>
        </div>
    </div>
    <p class="text-textcolor2 text-sm leading-relaxed mb-3">{language.backupServerDesc}</p>
    {#if serverBackupSummary}
        <div class="flex items-start gap-2 mb-3 p-2 border border-darkborderc/50 rounded-md bg-bgcolor/50">
            <span class="text-textcolor2 text-xs leading-relaxed">
                {language.backupServerSummary(serverBackupSummary.count, serverBackupSummary.totalSize)}
            </span>
        </div>
    {/if}

    <ServerBackupList
        bind:this={backupListEl}
        onStatsChange={(count, totalSize) => serverBackupSummary = { count, totalSize }}
    />
</SettingLayout>

<!-- Snapshot section ─────────────────────────────────────────────────────── -->
<SettingLayout variant="panel">
    <div class="flex items-center justify-between gap-2 mb-3">
        <div class="flex items-center gap-2 text-textcolor">
            <CameraIcon size={16} />
            <span class="font-medium">{language.backupSnapshot}</span>
        </div>
    </div>
    <p class="text-textcolor2 text-sm leading-relaxed mb-3">{language.storageBackupsAutoDesc}</p>

    <!-- Retention limits row -->
    {#if limits}
        <div class="flex items-center gap-2 mb-3 p-2 border border-darkborderc/50 rounded-md bg-bgcolor/50">
            <!-- Stacked so the (now longer) "current/savings" line wraps to as many
                 lines as it needs on a narrow phone instead of being truncated. -->
            <div class="flex flex-col gap-0.5 flex-1 min-w-0">
                <span class="text-textcolor2 text-xs">{language.backupSnapshotLimits(limits.maxCount, limits.maxBytes)}</span>
                <span class="text-textcolor2 text-xs opacity-70 wrap-break-word">
                    {language.backupSnapshotLimitsCurrent(limits.currentCount, limits.currentBytes, limits.logicalBytes)}
                </span>
            </div>
            <div class="shrink-0">
                <ShButton variant="outline" size="sm" onclick={openLimitsDialog}>
                    {language.backupSnapshotLimitsChange}
                </ShButton>
            </div>
        </div>
    {/if}

    <div class="flex items-center gap-2 text-textcolor mb-2">
        <span class="text-sm font-medium">{language.backupSnapshotAutomatic}</span>
    </div>

    {#if snapshotError}
        <ShAlert variant="destructive">
            {#snippet icon()}<TriangleAlertIcon />{/snippet}
            {snapshotError}
        </ShAlert>
    {:else if snapshots.length === 0 && !snapshotLoading}
        <p class="text-textcolor2 text-sm">{language.backupSnapshotEmpty}</p>
    {:else if snapshots.length > 0}
        <SettingLayout variant="list" scrollable className="max-h-[75vh]">
            {#each snapshots as snap (snap.key)}
                <SettingLayout variant="item">
                    <div class="flex flex-col min-w-0 flex-1">
                        <span class="text-sm text-textcolor">
                            {snap.timestamp ? new Date(snap.timestamp).toLocaleString() : snap.key}
                        </span>
                        <span class="text-xs text-textcolor2 tabular-nums">{fmtBytes(snap.size)}</span>
                    </div>
                    {#snippet control()}
                        <button class="text-textcolor2 risu-interactive-accent cursor-pointer" title={language.backupSnapshotRestore} aria-label={language.backupSnapshotRestore}
                            onclick={() => restoreSnapshot(snap)}>
                            <RotateCcwIcon size={18}/>
                        </button>
                        <button class="text-textcolor2 risu-interactive-danger cursor-pointer" title={language.backupSnapshotDelete} aria-label={language.backupSnapshotDelete}
                            onclick={() => deleteSnapshot(snap)}>
                            <TrashIcon size={18}/>
                        </button>
                    {/snippet}
                </SettingLayout>
            {/each}
        </SettingLayout>
    {/if}

	    <div class="flex items-center justify-between gap-2 text-textcolor mt-4 mb-2">
        <span class="text-sm font-medium">{language.backupSnapshotManual}</span>
	    </div>

    {#if manualSnapshots.length === 0 && !manualSnapshotLoading}
        <p class="text-textcolor2 text-sm">{language.manualSnapshotEmpty}</p>
    {:else if manualSnapshots.length > 0}
        <SettingLayout variant="list" scrollable className="max-h-[75vh]">
            {#each manualSnapshots as snap (snap.filename)}
                <SettingLayout variant="item">
                    <div class="flex flex-col min-w-0 flex-1">
                        <span class="text-sm text-textcolor">
                            {snap.timestamp ? new Date(snap.timestamp).toLocaleString() : snap.filename}
                        </span>
                        <span class="text-xs text-textcolor2 tabular-nums">{fmtBytes(snap.size)}</span>
                    </div>
                    {#snippet control()}
                        <button class="text-textcolor2 risu-interactive-accent cursor-pointer" title={language.backupSnapshotRestore} aria-label={language.backupSnapshotRestore}
                            onclick={() => restoreManualSnapshot(snap)}>
                            <RotateCcwIcon size={18}/>
                        </button>
                        <button class="text-textcolor2 risu-interactive-danger cursor-pointer" title={language.backupSnapshotDelete} aria-label={language.backupSnapshotDelete}
                            onclick={() => deleteManualSnapshot(snap)}>
                            <TrashIcon size={18}/>
                        </button>
                    {/snippet}
                </SettingLayout>
            {/each}
        </SettingLayout>
    {/if}
</SettingLayout>

<!-- Local backup section ────────────────────────────────────────────────── -->
<SettingLayout variant="panel">
    <div class="flex items-center gap-2 text-textcolor mb-3">
        <DownloadIcon size={16} />
        <span class="font-medium">{language.backupLocal}</span>
    </div>
    <p class="text-textcolor2 text-sm leading-relaxed mb-3">{language.backupLocalDesc}</p>

    <div class="flex flex-col gap-3">
        <SettingLayout variant="action" title={language.backupLocalDownload} description={language.help.backupLocalDownloadDesc}>
            {#snippet control()}
            <ShButton variant="outline" size="sm" onclick={downloadLocal}>
                <DownloadIcon />
                {language.backupLocalDownload}
            </ShButton>
            {/snippet}
        </SettingLayout>
        <SettingLayout variant="action" title={language.loadBackupLocal} description={language.help.backupLocalRestoreDesc}>
            {#snippet control()}
            <ShButton variant="outline" size="sm" onclick={restoreFromLocalFile}>
                <UploadIcon />
                {language.loadBackupLocal}
            </ShButton>
            {/snippet}
        </SettingLayout>
    </div>
</SettingLayout>

<!-- Data migration section ──────────────────────────────────────────────── -->
<SettingLayout variant="panel">
    <div class="flex items-center gap-2 text-textcolor mb-3">
        <TruckIcon size={16} />
        <span class="font-medium">{language.migration}</span>
    </div>
    <p class="text-textcolor2 text-sm leading-relaxed mb-3">{language.migrationDesc}</p>

    <div class="flex flex-col gap-3">
        <SettingLayout variant="action" title={language.saveBackupForUpstream} description={language.help.migrationUpstreamExportDesc}>
            {#snippet control()}
            <ShButton variant="outline" size="sm" onclick={downloadUpstreamLocal}>
                <DownloadIcon />
                {language.migrationCompatBackupExportButton}
            </ShButton>
            {/snippet}
        </SettingLayout>
        <SettingLayout variant="action" title={language.savePartialLocalBackup} description={language.help.migrationPartialBackupDesc}>
            {#snippet control()}
            <ShButton variant="outline" size="sm" onclick={SavePartialLocalBackup}>
                <DownloadIcon />
                {language.migrationCompatSnapshotExportButton}
            </ShButton>
            {/snippet}
        </SettingLayout>
        <SettingLayout variant="action" title={language.migrationLoadUpstreamBackup} description={language.help.migrationUpstreamRestoreDesc}>
            {#snippet control()}
            <ShButton variant="outline" size="sm" onclick={restoreFromUpstreamLocalFile}>
                <UploadIcon />
                {language.migrationCompatBackupImportButton}
            </ShButton>
            {/snippet}
        </SettingLayout>
        <SettingLayout variant="action" title={language.exportAsDataset} description={language.help.migrationDatasetExportDesc}>
            {#snippet control()}
            <ShButton variant="outline" size="sm" onclick={exportAsDataset}>
                <DownloadIcon />
                {language.migrationDatasetExportButton}
            </ShButton>
            {/snippet}
        </SettingLayout>
    </div>
</SettingLayout>
{/if}

<!-- Path-change dialog ──────────────────────────────────────────────────── -->
<ShDialog bind:open={pathDialogOpen} size="lg">
    {#snippet title()}{language.backupServerPathDialog}{/snippet}
    <p class="text-textcolor2 text-sm leading-relaxed mb-3">{language.backupServerPathDialogDesc}</p>
    <ShInput bind:value={pathDraft} placeholder="/absolute/path/to/backups" aria-label={language.backupServerPath} />
    {#if pathDialogError}
        <ShAlert variant="destructive" className="mt-3">
            {#snippet icon()}<TriangleAlertIcon />{/snippet}
            {pathDialogError}
        </ShAlert>
    {/if}
    {#snippet footer()}
        <div class="flex justify-end gap-2">
            <ShButton variant="outline" onclick={() => (pathDialogOpen = false)} disabled={pathDialogBusy}>
                {language.cancel}
            </ShButton>
            <ShButton variant="primary" onclick={submitPathChange} disabled={pathDialogBusy}>
                {language.confirm}
            </ShButton>
        </div>
    {/snippet}
</ShDialog>

<!-- Snapshot limits dialog ──────────────────────────────────────────────── -->
<ShDialog bind:open={limitsDialogOpen} size="lg">
    {#snippet title()}{language.backupSnapshotLimitsDialog}{/snippet}
    <p class="text-textcolor2 text-sm leading-relaxed mb-3">{language.backupSnapshotLimitsDialogDesc}</p>
    {#if limits}
        <div class="flex flex-col gap-3">
            <label class="flex flex-col gap-1">
                <span class="text-textcolor2 text-sm">{language.backupSnapshotLimitsCount}</span>
                <ShInput type="number" bind:value={limitsDraftCount}
                    min={limits.bounds.minCount} max={limits.bounds.maxCount} step={1} />
                <span class="text-textcolor2 text-xs opacity-70">
                    {language.backupSnapshotLimitsCountRange(limits.bounds.minCount, limits.bounds.maxCount)}
                </span>
            </label>
            <label class="flex flex-col gap-1">
                <span class="text-textcolor2 text-sm">{language.backupSnapshotLimitsBytes}</span>
                <ShInput type="number" bind:value={limitsDraftMB}
                    min={Math.round(limits.bounds.minBytes / 1024 / 1024)}
                    max={Math.round(limits.bounds.maxBytes / 1024 / 1024)}
                    step={10} />
                <span class="text-textcolor2 text-xs opacity-70">
                    {language.backupSnapshotLimitsBytesRange(
                        Math.round(limits.bounds.minBytes / 1024 / 1024),
                        Math.round(limits.bounds.maxBytes / 1024 / 1024)
                    )}
                </span>
            </label>
        </div>
    {/if}
    {#if limitsDialogError}
        <ShAlert variant="destructive" className="mt-3">
            {#snippet icon()}<TriangleAlertIcon />{/snippet}
            {limitsDialogError}
        </ShAlert>
    {/if}
    {#snippet footer()}
        <div class="flex justify-end gap-2">
            <ShButton variant="outline" onclick={() => (limitsDialogOpen = false)} disabled={limitsDialogBusy}>
                {language.cancel}
            </ShButton>
            <ShButton variant="primary" onclick={submitLimits} disabled={limitsDialogBusy}>
                {language.confirm}
            </ShButton>
        </div>
    {/snippet}
</ShDialog>
