import { isTrashExpired } from './trashRetention';
import { checkNullish } from "./util"
import { createEntityId } from 'src/ts/id';
import { get } from "svelte/store";
import { setDatabase, getDatabase, changeToThemePreset, type Database } from "./storage/database.svelte";
import { chatDraftKey, sweepOrphanDrafts } from "./storage/chatDraft";
import { checkRisuUpdate } from "./update";
import { syncPublicStatsVisibility } from "./publicStats";
import { botMakerMode, selectedCharID, loadedStore, DBState, LoadingStatusState, bootBackupPromptStore } from "./stores.svelte";
import { loadPlugins } from "./plugins/plugins.svelte";
import { alertError, alertMd, alertTOS, waitAlert, alertConfirm, alertInput } from "./alert";
import { characterURLImport } from "./characterCards";
import { defaultJailbreak, defaultMainPrompt, oldJailbreak, oldMainPrompt } from "./storage/defaultPrompts";
import { decodeRisuSave, encodeRisuSaveLegacy } from "./storage/risuSave";
import { updateAnimationSpeed } from "./gui/animation";
import { updateColorScheme, updateTextThemeAndCSS } from "./gui/colorscheme";
import { applyEarlyLanguage, changeLanguage, language } from "src/lang";
import { startObserveDom } from "./observer.svelte";
import { updateGuisize } from "./gui/guisize";
import { updateLorebooks } from "./characters";
import { initHotkey } from "./hotkey";
import { syncMobileBackNavigationGuard } from "./mobileBackNavigation";
import { moduleUpdate } from "./process/modules";
import {
    forageStorage,
    saveDb,
    setPatchSyncBaseline,
    getDbBackups,
    checkCharOrder
} from "./globalApi.svelte";
import { convertStubsToPlaceholders } from "./storage/chatStorage";
import { isChatStub, purgeUnsupportedGroupChats } from "./storage/database.svelte";
import { startSyncReceiver } from "./syncReceiver.svelte";
import { ConflictError } from "./storage/nodeStorage";
import { purgeOrphanAssets } from './storage/orphanAssets';
import { isNodeServer } from './platform';
import {
    applyPluginMemoryDecision,
    getPluginStorageWarningBytes,
    requestPluginMemoryDecision,
} from './plugins/pluginMemorySafety';

async function configurePluginStartupMemoryGuard() {
    const thresholdBytes = getPluginStorageWarningBytes()
    if (thresholdBytes === null) return
    const stats = await forageStorage.getPluginStorageStartupStats()
    if (stats.totalBytes < thresholdBytes) return
    const decision = await requestPluginMemoryDecision(stats, thresholdBytes)
    forageStorage.setPluginStorageExclusion(applyPluginMemoryDecision(decision))
}

export async function loadData() {
    const loaded = get(loadedStore)
    if (!loaded) {
        try {
            applyEarlyLanguage()
            let createdFreshDatabase = false
            {
                await forageStorage.Init()

                LoadingStatusState.text = "Loading Local Save File..."
                if (isNodeServer) {
                    await configurePluginStartupMemoryGuard()
                    const projection = await forageStorage.getDatabaseProjection<Database>()
                    if (projection.database === null) {
                        createdFreshDatabase = true
                        // The revision-gated first-run write prevents concurrent new clients
                        // from overwriting whichever initialization wins.
                        setDatabase({} as Database)
                    } else {
                        setPatchSyncBaseline(structuredClone(projection.database))
                        setDatabase(projection.database)
                    }
                } else {
                    const gotStorage = await forageStorage.getItem('database/database.bin') as unknown as Uint8Array
                    LoadingStatusState.text = "Decoding Local Save File..."
                    if (checkNullish(gotStorage)) {
                        createdFreshDatabase = true
                        setDatabase({} as Database)
                    } else {
                        try {
                            const decoded = await decodeRisuSave(gotStorage)
                            setPatchSyncBaseline(structuredClone(decoded))
                            setDatabase(decoded)
                        } catch (error) {
                            console.error(error)
                            const backups = await getDbBackups()
                            let backupLoaded = false
                            for (const backup of backups) {
                                try {
                                    LoadingStatusState.text = `Reading Backup File ${backup}...`
                                    const backupData = await forageStorage.getItem(`database/dbbackup-${backup}.bin`) as unknown as Uint8Array
                                    const backupDecoded = await decodeRisuSave(backupData)
                                    setPatchSyncBaseline(structuredClone(backupDecoded))
                                    setDatabase(backupDecoded)
                                    backupLoaded = true
                                    break
                                } catch (error) { }
                            }
                            if (!backupLoaded) {
                                throw "Forage: Your save file is corrupted"
                            }
                        }
                    }
                }

                characterURLImport()
            }
            if (createdFreshDatabase) {
                // setDatabase creates the standard preset but does not apply it. Apply it
                // only to fresh databases, and avoid saving defaults over the preset.
                changeToThemePreset(0, false)
                const browserLangShort = navigator.language.split('-')[0]
                const browserLanguageMap: Record<string, string> = {
                    de: 'de',
                    en: 'en',
                    ko: 'ko',
                    cn: 'cn',
                    vi: 'vi',
                    es: 'es',
                    zh: 'zh-Hant'
                }
                const mappedLanguage = browserLanguageMap[browserLangShort]
                if (mappedLanguage) {
                    const db = getDatabase()
                    db.language = mappedLanguage
                    changeLanguage(mappedLanguage)
                }

                if (isNodeServer) {
                    const initialized = await forageStorage.initializeDatabase(getDatabase(), 0)
                    // Another client may win revision 0; reload the persisted projection.
                    if (initialized.conflict) createdFreshDatabase = false
                    const persisted = await forageStorage.getDatabaseProjection<Database>()
                    if (persisted.database === null) {
                        throw new Error('Initial database projection was not persisted')
                    }
                    setPatchSyncBaseline(structuredClone(persisted.database))
                    setDatabase(persisted.database)
                } else {
                    const initializedStorage = encodeRisuSaveLegacy(getDatabase())
                    const initialEtag = forageStorage.getDbEtag()
                    try {
                        await forageStorage.setItem(
                            'database/database.bin',
                            initializedStorage,
                            initialEtag ?? undefined,
                        )
                    } catch (error) {
                        if (!(error instanceof ConflictError)) throw error
                        createdFreshDatabase = false
                    }

                    const persistedStorage = await forageStorage.getItem('database/database.bin') as unknown as Uint8Array
                    if (checkNullish(persistedStorage)) {
                        throw new Error('Initial database write did not persist database.bin')
                    }
                    const persistedDatabase = await decodeRisuSave(persistedStorage)
                    setPatchSyncBaseline(structuredClone(persistedDatabase))
                    setDatabase(persistedDatabase)
                }
            }
            LoadingStatusState.text = "Loading Plugins..."
            try {
                await loadPlugins()
            } catch (error) { }
            LoadingStatusState.text = "Checking For Format Update..."
            await checkNewFormat()

            // Convert server stubs to runtime chat placeholders.
            {
                const dbForConvert = getDatabase()
                for (const char of dbForConvert.characters) {
                    char.chats = convertStubsToPlaceholders(char.chats)
                }
            }

            const db = getDatabase();

            LoadingStatusState.text = "Updating States..."
            updateColorScheme()
            updateTextThemeAndCSS()
            updateAnimationSpeed()
            updateErrorHandling()
            updateGuisize()
            initHotkey()
            syncMobileBackNavigationGuard(db.disableMobileBackNavigation)
            if (db.botSettingAtStart) {
                botMakerMode.set(true)
            }
            // Run configured backups before the UI when their interval has elapsed.
            let scheduledBackupRan = false
            try {
                scheduledBackupRan = await maybeRunScheduledBackups()
            } catch (err) {
                console.warn('[bootstrap] scheduled backup failed:', err)
            }
            // The optional reminder blocks startup for its prompt; failures stay non-fatal.
            try {
                if (!scheduledBackupRan) {
                    await maybeRunBootBackupReminder()
                }
            } catch (err) {
                console.warn('[bootstrap] boot backup reminder failed:', err)
            }
            loadedStore.set(true)
            selectedCharID.set(-1)
            startObserveDom()
            assignIds()
            saveDb()
            startSyncReceiver()
            moduleUpdate()
            // Defer asset cleanup until after the UI loads.
            setTimeout(() => {
                cleanChunks().catch(console.error)
            }, 5_000)
            checkRisuUpdate()
            syncPublicStatsVisibility(db.hidePublicStats)
            if (import.meta.env.VITE_RISU_TOS === 'TRUE') {
                alertTOS().then((a) => {
                    if (a === false) {
                        location.reload()
                    }
                })
            }
        } catch (error) {
            alertError(error)
        }
    }
}



/** Bound startup requests so a stalled endpoint cannot hold the loading screen indefinitely. */
async function fetchWithTimeout(input: RequestInfo, init: RequestInit = {}, ms = 5000): Promise<Response> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), ms)
    try {
        return await fetch(input, { ...init, signal: controller.signal })
    } finally {
        clearTimeout(timer)
    }
}

interface BackupSchedule {
    enabled: boolean
    serverDays: number
    snapshotDays: number
}

function isDue(latestTimestamp: number | null, days: number) {
    if (!Number.isFinite(days) || days < 1) return false
    if (latestTimestamp == null || latestTimestamp <= 0) return true
    return Date.now() - latestTimestamp >= days * 24 * 60 * 60 * 1000
}

async function fetchLatestServerBackupTimestamp(auth: string): Promise<number | null> {
    const res = await fetchWithTimeout('/api/backup/server/list', { headers: { 'risu-auth': auth } })
    if (!res.ok) return null
    const json = await res.json()
    const backups = Array.isArray(json?.backups) ? json.backups : []
    let latest: number | null = null
    for (const backup of backups) {
        if (typeof backup?.createdAt !== 'number') continue
        if (latest == null || backup.createdAt > latest) latest = backup.createdAt
    }
    return latest
}

async function fetchLatestManualSnapshotTimestamp(auth: string): Promise<number | null> {
    const res = await fetchWithTimeout('/api/db/manual-snapshots', { headers: { 'risu-auth': auth } })
    if (!res.ok) return null
    const json = await res.json()
    const snapshots = Array.isArray(json?.snapshots) ? json.snapshots : []
    let latest: number | null = null
    for (const snapshot of snapshots) {
        if (typeof snapshot?.timestamp !== 'number') continue
        if (latest == null || snapshot.timestamp > latest) latest = snapshot.timestamp
    }
    return latest
}

async function maybeRunScheduledBackups(): Promise<boolean> {
    const auth = await forageStorage.createAuth()
    const res = await fetchWithTimeout('/api/backup/schedule', { headers: { 'risu-auth': auth } })
    if (!res.ok) return false
    const schedule = await res.json() as BackupSchedule
    if (!schedule?.enabled) return false
    const snapshotDays = Number(schedule?.snapshotDays)
    const serverDays = Number(schedule?.serverDays)
    const snapshotEnabled = Number.isFinite(snapshotDays) && snapshotDays > 0
    const serverEnabled = Number.isFinite(serverDays) && serverDays > 0
    if (!snapshotEnabled && !serverEnabled) return false

    const { SaveManualSnapshot, SaveServerBackup } = await import('./drive/backuplocal')
    let ran = false

    if (snapshotEnabled) {
        const latestSnapshot = await fetchLatestManualSnapshotTimestamp(auth)
        if (isDue(latestSnapshot, snapshotDays)) {
            const result = await SaveManualSnapshot(language.backupCreatedAutomatically)
            ran = !!result || ran
        }
    }

    if (serverEnabled) {
        const latestBackup = await fetchLatestServerBackupTimestamp(auth)
        if (isDue(latestBackup, serverDays)) {
            const result = await SaveServerBackup(language.backupCreatedAutomatically)
            ran = !!result || ran
        }
    }

    return ran
}

/** Prompt before startup completes when the boot backup reminder is enabled. */
async function maybeRunBootBackupReminder() {
    let enabled = false
    try {
        const auth = await forageStorage.createAuth()
        const res = await fetchWithTimeout('/api/backup/boot-reminder', { headers: { 'risu-auth': auth } })
        if (!res.ok) return
        const json = await res.json()
        enabled = !!json.enabled
    } catch {
        return  // Non-fatal — skip the prompt if the endpoint is unreachable / slow.
    }
    if (!enabled) return

    // Use backupDisk, the actual destination, so free-space warnings target the right mount.
    let estimate: number | null = null
    let free: number | null = null
    let total: number | null = null
    try {
        const auth = await forageStorage.createAuth()
        const res = await fetchWithTimeout('/api/db/stats?scope=backup', { headers: { 'risu-auth': auth } })
        if (res.ok) {
            const stats = await res.json()
            if (typeof stats?.estimatedBackupSize === 'number') estimate = stats.estimatedBackupSize
            const d = stats?.backupDisk ?? stats?.disk
            if (typeof d?.free === 'number') free = d.free
            if (typeof d?.total === 'number') total = d.total
        }
    } catch { /* keep nulls */ }

    const insufficient = (estimate != null && free != null && estimate > free)

    const mode = await new Promise<'skip' | 'snapshot' | 'full'>((resolve) => {
        bootBackupPromptStore.set({ estimate, free, total, insufficient, resolve })
    })
    if (mode === 'skip') return
    const { SaveManualSnapshot, SaveServerBackup } = await import('./drive/backuplocal')
    if (mode === 'snapshot') {
        await SaveManualSnapshot()
    } else {
        await SaveServerBackup()
    }
}

function updateErrorHandling() {
    const errorHandler = (event: ErrorEvent) => {
        console.error(event.error);
        if(!(event.error?.target instanceof Worker)){
            alertError(event.error);
        }
    };
    const rejectHandler = (event: PromiseRejectionEvent) => {
        console.error(event.reason);
        alertError(event.reason);
    };
    window.addEventListener('error', errorHandler);
    window.addEventListener('unhandledrejection', rejectHandler);
}

async function checkNewFormat(): Promise<void> {
    let db = getDatabase();

    db.characters = db.characters.map((v) => {
        if (!v) {
            return null;
        }
        v.chaId ??= createEntityId();
        v.type ??= 'character';
        v.chats ??= [];
        v.customscript ??= [];
        v.firstMessage ??= '';
        v.globalLore ??= [];
        v.name ??= '';
        v.viewScreen ??= 'none';
        v.emotionImages = v.emotionImages ?? [];

        if (v.type === 'character') {
            v.bias ??= [];
            v.characterVersion ??= '';
            v.creator ??= '';
            v.desc ??= '';
            v.utilityBot ??= false;
            v.tags ??= [];
            v.systemPrompt ??= '';
            v.scenario ??= '';
        }
        return v;
    }).filter((v) => {
        return v !== null;
    });

    const removedGroupChats = purgeUnsupportedGroupChats(db)
    if (removedGroupChats > 0) {
        console.warn(`[bootstrap] Removed ${removedGroupChats} unsupported group chat entr${removedGroupChats === 1 ? 'y' : 'ies'} from database`)
    }

    db.modules = await Promise.all((db.modules ?? []).map(async (v) => {
        if (v?.lorebook) {
            if (!Array.isArray(v.lorebook)) {
                console.error('Critical: Invalid lorebook format detected in module');
                console.error('Module data:', JSON.stringify(v, null, 2));
                
                alertError(language.bootstrap.dataCorruptionDetected(v.name || 'Unknown', typeof v.lorebook));
                await waitAlert();

                const shouldReport = await alertConfirm(language.bootstrap.reportErrorQuestion);
                
                if (shouldReport) {
                    try {
                        // Keep diagnostics bounded and exclude chat content.
                        const diagnosticInfo = {
                            timestamp: new Date().toISOString(),
                            moduleName: v.name || 'Unknown',
                            lorebookType: typeof v.lorebook,
                            lorebookValue: JSON.stringify(v.lorebook).substring(0, 500), // First 500 chars only
                            isArray: Array.isArray(v.lorebook),
                            keys: v.lorebook ? Object.keys(v.lorebook).join(', ') : 'N/A',
                            formatVersion: db.formatversion || 'Unknown'
                        };
                        
                        const reportData = JSON.stringify(diagnosticInfo, null, 2);
                        await alertMd(language.bootstrap.diagnosticInformation(reportData));
                        await waitAlert();
                        
                        if (import.meta.env.DEV) {
                            console.log('Diagnostic information for developers:', diagnosticInfo);
                        }
                    } catch (reportError) {
                        console.error('Failed to generate diagnostic report:', reportError);
                    }
                }
                
                const shouldReset = await alertConfirm(language.bootstrap.resetLorebookQuestion);
                
                if (shouldReset) {
                    v.lorebook = [];
                    if (import.meta.env.DEV) {
                        console.log('Lorebook reset to empty array by user choice');
                    }
                } else {
                    console.warn('User chose to keep corrupted lorebook data');
                }
            } else {
                v.lorebook = updateLorebooks(v.lorebook);
            }
        }
        return v
    }));
    
    db.modules = db.modules.filter((v) => {
        return v !== null && v !== undefined;
    });

    db.personas = (db.personas ?? []).map((v) => {
        v.id ??= createEntityId()
        return v
    }).filter((v) => {
        return v !== null && v !== undefined;
    });

    if (!db.formatversion) {
        function checkClean(data: string) {

            if (data.startsWith('assets') || (data.length < 3)) {
                return data
            }
            else {
                const d = 'assets/' + (data.replace(/\\/g, '/').split('assets/')[1])
                if (!d) {
                    return data
                }
                return d;
            }
        }

        db.customBackground = checkClean(db.customBackground);
        db.userIcon = checkClean(db.userIcon);

        for (let i = 0; i < db.characters.length; i++) {
            if (db.characters[i].image) {
                db.characters[i].image = checkClean(db.characters[i].image);
            }
            if (db.characters[i].emotionImages) {
                for (let i2 = 0; i2 < db.characters[i].emotionImages.length; i2++) {
                    if (db.characters[i].emotionImages[i2] && db.characters[i].emotionImages[i2].length >= 2) {
                        db.characters[i].emotionImages[i2][1] = checkClean(db.characters[i].emotionImages[i2][1]);
                    }
                }
            }
        }

        db.formatversion = 2;
    }
    if (db.formatversion < 3) db.formatversion = 3;
    if (db.formatversion < 4) {
        db.formatversion = 4;
    }
    if (db.formatversion < 5) {
        if (db.loreBookToken < 8000) {
            db.loreBookToken = 8000;
        }
        db.formatversion = 5;
    }
    if (!db.characterOrder) {
        db.characterOrder = [];
    }
    if (db.mainPrompt === oldMainPrompt) {
        db.mainPrompt = defaultMainPrompt;
    }
    if (db.mainPrompt === oldJailbreak) {
        db.mainPrompt = defaultJailbreak;
    }
    const trashCleanupTime = Date.now();
    db.characters = db.characters.filter(character =>
        !isTrashExpired(character.trashTime, db.trashRetentionDays, trashCleanupTime));
    setDatabase(db);
    checkCharOrder();

    // Remove drafts whose chats disappeared through deletion, trash purge, or imports.
    const validDraftKeys = new Set<string>();
    for (const char of db.characters) {
        if (!char?.chaId) continue;
        for (const chat of char.chats ?? []) {
            if (chat?.id) validDraftKeys.add(chatDraftKey(char.chaId, chat.id));
        }
    }
    void sweepOrphanDrafts(validDraftKeys);
}

async function cleanChunks() {
    const db = getDatabase()
    if(db.autoCleanAssets === true){
        try {
            await purgeOrphanAssets()
        }
        catch(error){
            console.warn('[bootstrap] automatic orphan asset cleanup failed:', error)
        }
    }
}


function assignIds() {
    if (!DBState?.db?.characters) {
        return
    }
    const assignedIds = new Set<string>()
    for (let i = 0; i < DBState.db.characters.length; i++) {
        const cha = DBState.db.characters[i]
        if (!cha.chaId) {
            cha.chaId = createEntityId()
        }
        if (assignedIds.has(cha.chaId)) {
            console.warn(`Duplicate chaId found: ${cha.chaId}. Assigning new ID.`);
            cha.chaId = createEntityId();
        }
        assignedIds.add(cha.chaId)
        for (let i2 = 0; i2 < cha.chats.length; i2++) {
            const chat = cha.chats[i2]
            if (!chat.id) {
                chat.id = createEntityId()
            }
            if (assignedIds.has(chat.id)) {
                console.warn(`Duplicate chat ID found: ${chat.id}. Assigning new ID.`);
                chat.id = createEntityId();
            }
            assignedIds.add(chat.id)
        }
    }
}
