export { globalFetch } from './network/globalFetch';
import { isDebugEnabled } from './debug'
import { getChatPage, setChatPage } from './storage/chatSelection.svelte'
import { Buffer } from 'buffer'
import { checkNullish, sleep } from "./util"
import { createEntityId } from 'src/ts/id';
import { tick } from "svelte";
import { get } from "svelte/store";
import streamSaver from 'streamsaver';
import { setDatabase, type Chat, type Database, type Message, type character, getDatabase, pocketKeiVer, getCurrentCharacter, loadTogglesFromChat, normalizeChat } from "./storage/database.svelte";
import { botMakerMode, selectedCharID, loadedStore, DBState, LoadingStatusState, selIdState, invalidateChatRoom, claimLoadingOverlay, dismissClaimedLoadingOverlay, chatDeselected } from "./stores.svelte";
import { loadPlugins } from "./plugins/plugins.svelte";
import { alertConfirm, alertError, alertMd, alertSelect, alertTOS, waitAlert, notifySuccess, notifyError } from "./alert";
import { hasher } from "./parser/parser.svelte";
import { characterURLImport } from "./characterCards";
import { defaultJailbreak, defaultMainPrompt, oldJailbreak, oldMainPrompt } from "./storage/defaultPrompts";
import { decodeRisuSave, encodeRisuSaveLegacy, RisuSaveEncoder, RisuSavePatcher, type toSaveType } from "./storage/risuSave";
import { findChatInternalFieldOps } from '../../shared/chatShape.mjs';
import { discardPendingChatSaves, fetchChatFromServer, getChatServerEtag, isHydrating, saveChatToServer, ensureChatHydrated, chatToStub, classifyChat, convertStubsToPlaceholders, setChatServerEtag, mergeHydratedChatWithMetadata } from "./storage/chatStorage";
import {
    acknowledgeProjectionOnlyChatConflict,
    cloneChatValue,
    discardAllChatWorkingCopies,
    discardAllChatGenerationProjections,
    consumeChatSyncApplied,
    listDirtyChatWorkingCopies,
    markChatWorkingCopyDirty,
    markChatSyncApplied,
    observeChatGenerationProjection,
    rebaseChatWorkingCopy,
    pruneChatServerStates,
} from './storage/chatWorkingCopy';
import { reissueMessageIds } from './chatClone';
import { preparePatchConflictRebase, reconcilePendingChanges } from "./storage/patchRebase";
import { createDelta } from '../../shared/guardedDelta.mjs';
import { chooseSaveConflict } from './storage/saveConflict';
import { DeltaSave } from './storage/deltaSave';
import type { PatchItemResult } from './storage/nodeStorage';
import {
    isClientWritableCharacterField,
    visitClientWritableRootValues,
} from './storage/persistenceShape';
import { forageStorage } from "./storage/autoStorage";
import { getAssetUrl } from './storage/assetTransport';
import {
    registerSyncedDatabaseHandler,
    reconcileHydratedChats,
    type SyncedDatabaseOptions,
} from './sync/databaseSync';
import { ConflictError, getSyncClientId } from "./storage/nodeStorage";
import { ChatSaveError, SaveConflictError, SaveRetryPolicy, isCancelledSaveConflict, type SaveAttemptResult } from './storage/storageRequest';
import { isNodeServer } from "./platform";
import { updateAnimationSpeed } from "./gui/animation";
import { updateColorScheme, updateTextThemeAndCSS } from "./gui/colorscheme";
import { language } from "src/lang";
import { startObserveDom } from "./observer.svelte";
import { updateGuisize } from "./gui/guisize";
import { deepTouch } from "./gui/deepTouch.svelte";
import { updateLorebooks } from "./characters";
import { moduleUpdate } from "./process/modules";
import {
    createFetchLogEntry,
    clearServerFetchLogs as clearServerFetchLogsRequest,
    setServerFetchLogLimit as setServerFetchLogLimitRequest,
    deleteServerFetchLog as deleteServerFetchLogRequest,
    formatFetchLogValue,
    getServerFetchLogByChatId as getServerFetchLogByChatIdRequest,
    getServerFetchLogById as getServerFetchLogByIdRequest,
    getServerFetchLogs as getServerFetchLogsRequest,
    type FetchLog,
    type FetchLogPage,
    type FetchLogSummary,
    type RequestLogClearScope,
} from "./requestLogStore";
import {
    configureRevenantGenerationClient,
} from "./process/revenant/transport";
import {
    configureNativeFetchLogging,
    fetchNative,
    type FetchNativeArgs,
} from './network/nativeFetch';

export { fetchNative, type FetchNativeArgs }

export { forageStorage }
configureRevenantGenerationClient({
    createAuth: () => forageStorage.createAuth(),
    getSyncClientId,
})

export type { FetchLog, FetchLogPage, FetchLogSummary, RequestLogStorage } from "./requestLogStore";

let fetchLog: FetchLog[] = $state([])

function pushFetchLog(log: Omit<FetchLog, 'id' | 'timestamp' | 'clientId' | 'platform'> & { id?: string, timestamp?: number, clientId?: string, platform?: string }) {
    const entry = createFetchLogEntry(log)
    fetchLog.unshift(entry)
    return entry
}

configureNativeFetchLogging({
    create: entry => pushFetchLog(entry as Parameters<typeof pushFetchLog>[0]).id,
    update: (id, response, status, success) => {
        const entry = fetchLog.find(log => log.id === id)
        if (!entry) return
        entry.response = formatFetchLogValue(response)
        entry.responseType = 'stream'
        if (status !== undefined) entry.status = status
        if (success !== undefined) entry.success = success
    },
})

export { downloadFile } from './download'

let fileCache: {
    origin: string[], res: (Uint8Array | 'loading')[]
} = {
    origin: [],
    res: []
}

export async function getFileSrc(loc: string) {
    // A direct server URL lets the browser cache the response using HTTP headers,
    // so repeated renders (sidebar, chat) cost zero network after first load.
    if ((globalThis as any).__NODE__) {
        return getAssetUrl(loc)
    }
    try {
        let ind = fileCache.origin.indexOf(loc)
        if (ind === -1) {
            ind = fileCache.origin.length
            fileCache.origin.push(loc)
            fileCache.res.push('loading')
            const f: Uint8Array = await forageStorage.getItem(loc) as unknown as Uint8Array
            fileCache.res[ind] = f
            return `data:image/png;base64,${Buffer.from(f).toString('base64')}`
        }
        else {
            while (fileCache.res[ind] === 'loading') {
                await sleep(10)
            }
            return `data:image/png;base64,${Buffer.from(fileCache.res[ind]).toString('base64')}`
        }
    } catch (error) {
        console.error(error)
        return ''
    }
}

export async function readImage(data: string) {
    return (await forageStorage.getItem(data) as unknown as Uint8Array)
}

export async function saveAsset(data: Uint8Array, customId: string = '', fileName: string = '') {
    let id = ''
    if (customId !== '') {
        id = customId
    }
    else {
        try {
            id = await hasher(data)
        } catch (error) {
            id = createEntityId()
        }
    }
    let fileExtension: string = 'png'
    if (fileName) {
        fileExtension = fileName.split('.').pop()
    }
    let form = `assets/${id}.${fileExtension}`
    const replacer = await forageStorage.setItem(form, data)
    if (replacer) {
        return replacer
    }
    return form
}

export async function loadAsset(id: string) {
    return await forageStorage.getItem(id) as unknown as Uint8Array
}

export let saving = $state({
    state: false
})

export let requiresFullEncoderReload = $state({
    state: false
})

interface ImmediateSaveOptions {
    forceFullWrite?: boolean
    requireSuccess?: boolean
    characterIds?: string[]
    chatTargets?: { characterId: string, chatId: string }[]
}

let requestImmediateSaveImpl: ((options?: ImmediateSaveOptions) => Promise<void> | void) = () => {}
let patchSyncBaseline: Database | null = null

// Throttle the client/server-PATCH chat-guard toast — the underlying root
// cause may keep firing every 5s save cycle, and we don't want to spam the
// user. One toast per 5-minute window is enough to surface the situation.
// Both guards rebase on the server projection and retry, so the toast is
// informational, not actionable.
const CHAT_GUARD_TOAST_INTERVAL_MS = 5 * 60 * 1000
let lastChatGuardToastTs = 0

function showChatGuardToastThrottled(source: 'client' | 'server') {
    const now = Date.now()
    if (now - lastChatGuardToastTs < CHAT_GUARD_TOAST_INTERVAL_MS) return
    lastChatGuardToastTs = now
    notifyError(language.errors.chatGuardTitle, {
        description: `${language.errors.chatGuardDesc} [${source}]`,
        source: 'chat-guard',
    })
}

export function requestImmediateSave(options?: ImmediateSaveOptions) {
    return requestImmediateSaveImpl(options)
}

export function setPatchSyncBaseline(data: Database | null) {
    patchSyncBaseline = data ? structuredClone(data) as Database : null
}

export async function saveDb(onReady?: () => Promise<void>) {
    let changed = false
    let syncApplying = false
    let saveInFlight: Promise<void> | null = null
    let cancelPendingSave = () => {}
    const knownChatIdsByCharacter = new Map<string, Set<string>>(
        (getDatabase()?.characters ?? [])
            .filter(character => character?.chaId)
            .map(character => [
                character.chaId,
                new Set((character.chats ?? []).map(chat => chat?.id).filter(Boolean)),
            ])
    )
    const changeTracker: toSaveType = {
        character: [],
        chat: [],
        root: false,
        botPreset: false,
        modules: false,
        plugins: false,
        pluginCustomStorage: false
    }

    // database.bin remains the compatibility format for non-Node storage and
    // explicit backup flows. Node autosaves operate on the relational JSON
    // projection and therefore do not build a binary encoder cache.
    let encoder: RisuSaveEncoder | null = null
    if (!isNodeServer) {
        encoder = new RisuSaveEncoder()
        await encoder.init(getDatabase())
    }

    let patcher = new RisuSavePatcher()
    let acceptedPatchBaseline: Database | null = null
    // Hash of the accepted projection; an unchanged patcher hash means a save has nothing to send.
    let acceptedPatchHash: string | null = null
    function acceptPatcherBaseline() {
        acceptedPatchBaseline = patcher.getBaselineSnapshot()
        acceptedPatchHash = patcher.hash()
    }
    let acceptedProjectionRevision = forageStorage.getDbRevision()
    type ProjectionSaveSnapshot = { base: Database, local: Database, tracked: toSaveType }
    async function readProjectionWorkingCopy(snapshot: ProjectionSaveSnapshot) {
        const currentPatcher = new RisuSavePatcher()
        await currentPatcher.init(snapshot.base)
        mergeTrackedChanges(snapshot.tracked, changeTracker)
        await currentPatcher.set(getDatabase(), snapshot.tracked)
        return currentPatcher.getBaselineSnapshot()
    }
    const projectionDeltaSave = new DeltaSave<ProjectionSaveSnapshot, PatchItemResult>(
        async (request, snapshot) => {
            while (true) {
                const result = await forageStorage.patchDatabase(request)
                if (result.success) return result
                const error = new ConflictError('Database fields changed concurrently', result.etag ?? '', result.conflictCode)
                if (!result.conflict) throw error
                const projection = await forageStorage.getDatabaseProjection<Database>()
                if (!projection.database) throw error
                snapshot.local = await readProjectionWorkingCopy(snapshot)
                const changes = createDelta(snapshot.base, snapshot.local)
                const resolved = await chooseSaveConflict(snapshot.base, changes, projection.database)
                const pendingChanges = structuredClone(changeTracker)
                const runtime = reconcilePendingChanges(
                    snapshot.local, JSON.parse(JSON.stringify(getDatabase())), resolved,
                ).mergedValue
                syncApplying = true
                try { await replaceRuntimeDatabase(runtime) }
                finally { syncApplying = false }
                requeueTrackedChanges(pendingChanges)
                snapshot.base = projection.database
                snapshot.local = resolved
                request.changes = createDelta(snapshot.base, resolved)
                if (request.changes.length === 0) return { success: true, etag: projection.etag, revision: projection.revision }
            }
        },
        async (snapshot, result) => {
            await patcher.init(snapshot.local)
            acceptPatcherBaseline()
            if (result.revision !== undefined) acceptedProjectionRevision = result.revision
        },
    )
    if (isNodeServer) {
        await patcher.init(patchSyncBaseline ?? getDatabase())
        acceptPatcherBaseline()
        patchSyncBaseline = null
    }

    async function resetPatcherToAcceptedBaseline() {
        patcher = new RisuSavePatcher()
        await patcher.init(acceptedPatchBaseline)
    }

    function hasTrackedChanges(toSave: toSaveType) {
        return !!(
            toSave.botPreset ||
            toSave.modules ||
            toSave.plugins ||
            toSave.pluginCustomStorage ||
            toSave.root ||
            toSave.character.length > 0 ||
            toSave.chat.length > 0
        )
    }

    function takeTrackedChanges() {
        const toSave = structuredClone(changeTracker)
        clearTrackedChanges()
        return toSave
    }

    function clearTrackedChanges() {
        changeTracker.character = []
        changeTracker.chat = []
        changeTracker.root = false
        changeTracker.botPreset = false
        changeTracker.modules = false
        changeTracker.plugins = false
        changeTracker.pluginCustomStorage = false
    }

    /** Install fetched/rebased database state without turning its reactive
     * replacement effects into local save intent. */
    async function replaceRuntimeDatabase(
        data: Database,
        serverAppliedTargets: SyncedDatabaseOptions['serverAppliedChats'] = [],
    ) {
        changed = false
        cancelPendingSave()
        clearTrackedChanges()
        const previousIndex = get(selectedCharID)
        const previousCharacterId = getDatabase()?.characters?.[previousIndex]?.chaId
        setDatabase(data)
        if (previousCharacterId) {
            const nextIndex = data.characters.findIndex(character =>
                character?.chaId === previousCharacterId)
            selectedCharID.set(nextIndex)
        }
        for (const target of serverAppliedTargets ?? []) {
            const character = DBState.db.characters?.find(item =>
                item?.chaId === target.characterId)
            const chat = character?.chats?.find(item => item?.id === target.chatId)
            if (chat && !chat._placeholder) {
                markChatSyncApplied(chat)
            }
        }
        pruneChatServerStates(DBState.db.characters.flatMap(character =>
            character.chats.filter(chat => chat?.id && !chat._placeholder)
                .map(chat => ({ characterId: character.chaId, chatId: chat.id }))))
        await tick()
        clearTrackedChanges()
        cancelPendingSave()
    }

    async function flushServerDbKeepalive() {
        try {
            fetch('/api/db/flush', {
                method: 'POST',
                keepalive: true,
                credentials: 'same-origin',
                headers: {
                    'x-sync-client-id': getSyncClientId(),
                },
            }).catch(() => {})
        } catch {
            // ignore best-effort flush failures
        }
    }

    $effect.root(() => {

        let knownCharacterIds = new Set<string>((getDatabase()?.characters ?? []).map((character) => character?.chaId).filter(Boolean))
        let didInitRootEffect = false
        let didInitBotPresetEffect = false
        let didInitModulesEffect = false
        let didInitPluginsEffect = false
        let didInitPluginStorageEffect = false
        let didInitGeneralEffect = false
        let trackedActiveChatKey = ''

        const debounceTime = 500;
        let saveTimeout: ReturnType<typeof setTimeout> | null = null;

        function saveTimeoutExecute() {
            if (syncApplying) return
            if (saveTimeout) {
                clearTimeout(saveTimeout);
            }
            saveTimeout = setTimeout(() => {
                changed = true;
            }, debounceTime);
        }
        cancelPendingSave = () => {
            if (saveTimeout) {
                clearTimeout(saveTimeout)
                saveTimeout = null
            }
        }

        function flushImmediate() {
            if (syncApplying) return
            if (saveTimeout) {
                clearTimeout(saveTimeout);
                saveTimeout = null;
            }
            changed = true;
            void triggerSave({
                skipBroadcast: true,
            })
            void flushServerDbKeepalive()
        }
        document.addEventListener('visibilitychange', () => {
            if (document.visibilityState === 'hidden') flushImmediate();
        });
        window.addEventListener('pagehide', flushImmediate);

        $effect(() => {
            for (const key in DBState.db) {
                if (
                    key !== 'characters' && key !== 'botPresets' && key !== 'modules' &&
                    key !== 'plugins' && key !== 'pluginCustomStorage'
                ) {
                    visitClientWritableRootValues(key, DBState.db[key], deepTouch)
                }
            }
            if (!didInitRootEffect) {
                didInitRootEffect = true
                return
            }
            changeTracker.root = true
            saveTimeoutExecute()
        })
        $effect(() => {
            DBState.db.activePromptPresetId
            try { deepTouch(DBState.db.botPresets) } catch (e) {
                console.warn('[Save] deepTouch(botPresets) failed:', e)
                return
            }
            if (!didInitBotPresetEffect) {
                didInitBotPresetEffect = true
                return
            }
            changeTracker.botPreset = true
            saveTimeoutExecute()
        })
        $effect(() => {
            try { deepTouch(DBState.db.modules) } catch (e) {
                console.warn('[Save] deepTouch(modules) failed:', e)
                return
            }
            if (!didInitModulesEffect) {
                didInitModulesEffect = true
                return
            }
            changeTracker.modules = true
            saveTimeoutExecute()
        })
        $effect(() => {
            deepTouch(DBState.db.plugins)
            if (!didInitPluginsEffect) {
                didInitPluginsEffect = true
                return
            }
            changeTracker.plugins = true
            saveTimeoutExecute()
        })
        $effect(() => {
            deepTouch(DBState.db.pluginCustomStorage)
            if (!didInitPluginStorageEffect) {
                didInitPluginStorageEffect = true
                return
            }
            changeTracker.pluginCustomStorage = true
            saveTimeoutExecute()
        })
        $effect(() => {
            const currentCharacterIds = (DBState?.db?.characters ?? []).map((character) => character?.chaId).filter(Boolean)
            deepTouch(currentCharacterIds)

            const currentCharacterIdSet = new Set<string>(currentCharacterIds)
            for (const previousCharacterId of knownCharacterIds) {
                if (!currentCharacterIdSet.has(previousCharacterId)) {
                    changeTracker.character = [previousCharacterId, ...changeTracker.character.filter((v) => v !== previousCharacterId)]
                }
            }
            knownCharacterIds = currentCharacterIdSet

            if (DBState?.db?.characters?.[selIdState.selId]) {
                const activeCharacter = DBState.db.characters[selIdState.selId]
                for (const key in DBState.db.characters[selIdState.selId]) {
                    // Exclude chats — chat changes are tracked via chat-specific server save, not database.bin
                    if (key !== 'chats' && isClientWritableCharacterField(key)) {
                        deepTouch(DBState.db.characters[selIdState.selId][key])
                    }
                }
                // Track stub metadata and chat ordering for database.bin persistence.
                deepTouch(DBState.db.characters[selIdState.selId].chats.map(c => ({
                    id: c.id,
                    name: c.name,
                    lastDate: c.lastDate,
                    folderId: c.folderId,
                })))
                if (changeTracker.character[0] !== DBState.db.characters[selIdState.selId]?.chaId) {
                    changeTracker.character.unshift(DBState.db.characters[selIdState.selId]?.chaId)
                }
                if (!syncApplying) {
                    const knownChatIds = knownChatIdsByCharacter.get(activeCharacter.chaId) ?? new Set<string>()
                    for (const chat of activeCharacter.chats ?? []) {
                        if (chat?.id && !chat._placeholder && !knownChatIds.has(chat.id)) {
                            markChatWorkingCopyDirty(
                                activeCharacter.chaId,
                                chat.id,
                                getChatServerEtag(activeCharacter.chaId, chat.id),
                            )
                        }
                    }
                }
            }
            if (!didInitGeneralEffect) {
                didInitGeneralEffect = true
                changeTracker.character = []
                changeTracker.chat = []
                return
            }
            saveTimeoutExecute()
        })
        $effect(() => {
            const activeChar = DBState?.db?.characters?.[selIdState.selId]
            const activeChat = activeChar?.chats?.[getChatPage(activeChar)]
            if (activeChat) {
                deepTouch(activeChat)
            }

            const activeChaId = activeChar?.chaId ?? ''
            const activeChatId = activeChat?.id ?? ''
            const activeKey = activeChaId && activeChatId ? `${activeChaId}|${activeChatId}` : ''

            if (!activeKey) {
                trackedActiveChatKey = ''
                return
            }

            if (syncApplying) return

            // Selecting a different chat establishes a new baseline; only later edits are dirty.
            if (trackedActiveChatKey !== activeKey) {
                trackedActiveChatKey = activeKey
                return
            }

            if (isHydrating(activeChaId, activeChatId)) {
                return
            }

            if (consumeChatSyncApplied(activeChat)) return

            const projectionChange = observeChatGenerationProjection(activeChaId, activeChat)
            if (projectionChange === 'projection') return
            // A legacy/non-Revenant stream has no target ownership metadata,
            // so its structurally transient body keeps the former protection.
            if (projectionChange === 'inactive' && activeChat.isStreaming) return

            markChatWorkingCopyDirty(
                activeChaId,
                activeChatId,
                getChatServerEtag(activeChaId, activeChatId),
            )

            if (
                changeTracker.chat[0]?.[0] !== activeChaId ||
                changeTracker.chat[0]?.[1] !== activeChatId
            ) {
                changeTracker.chat.unshift([activeChaId, activeChatId])
            }
            saveTimeoutExecute()
        })
    })

    registerSyncedDatabaseHandler(async (data, etag, options) => {
        if (saveInFlight) await saveInFlight
        if (!options?.authoritativeChatReset && options?.revision !== undefined
            && acceptedProjectionRevision !== null && options.revision < acceptedProjectionRevision) {
            window.dispatchEvent(new Event('risu-sync-refresh-requested'))
            return
        }
        const pendingChanges = structuredClone(changeTracker)
        let nextBaseline = data
        if (isNodeServer && acceptedPatchBaseline && !options?.authoritativeChatReset) {
            const localPatcher = new RisuSavePatcher()
            await localPatcher.init(acceptedPatchBaseline)
            await localPatcher.set(getDatabase(), pendingChanges)
            const reconciled = reconcilePendingChanges(acceptedPatchBaseline, localPatcher.getBaselineSnapshot(), data)
            data = reconciled.mergedValue
            nextBaseline = reconciled.baseline
        }
        if (!options?.authoritativeChatReset) reconcileHydratedChats(data, options?.serverAppliedChats ?? [])
        syncApplying = true
        try {
            if (options?.authoritativeChatReset) {
                discardAllChatWorkingCopies()
                discardAllChatGenerationProjections()
                discardPendingChatSaves()
                projectionDeltaSave.clear()
            }
            await replaceRuntimeDatabase(data, options?.serverAppliedChats)
            updateColorScheme()
            updateTextThemeAndCSS()
            updateAnimationSpeed()
            updateGuisize()
            if (!isNodeServer) {
                encoder = new RisuSaveEncoder()
                await encoder.init(data)
            }
            if (isNodeServer) {
                patcher = new RisuSavePatcher()
                await patcher.init(nextBaseline)
                acceptPatcherBaseline()
                if (options?.revision !== undefined) acceptedProjectionRevision = options.revision
            }
            forageStorage.setDbEtag(etag)
            knownChatIdsByCharacter.clear()
            for (const character of data.characters ?? []) {
                if (!character?.chaId) continue
                knownChatIdsByCharacter.set(
                    character.chaId,
                    new Set((character.chats ?? []).map(chat => chat?.id).filter(Boolean)),
                )
            }
            if (!options?.authoritativeChatReset) {
                requeueTrackedChanges(pendingChanges)
                changeTracker.chat = listDirtyChatWorkingCopies().map(chat => [
                    chat.characterId,
                    chat.chatId,
                ])
            }
            changed = hasTrackedChanges(changeTracker)
        } finally {
            syncApplying = false
        }
    })

    function mergeTrackedChanges(target: toSaveType, toSave: toSaveType) {
        target.character = [...new Set([...toSave.character, ...target.character])]
        const chatSeen = new Set<string>()
        target.chat = [...toSave.chat, ...target.chat].filter((chatPair) => {
            const key = `${chatPair?.[0] ?? ''}|${chatPair?.[1] ?? ''}`
            if (chatSeen.has(key)) {
                return false
            }
            chatSeen.add(key)
            return true
        })
        target.botPreset = target.botPreset || toSave.botPreset
        target.modules = target.modules || toSave.modules
        target.plugins = target.plugins || toSave.plugins
        target.pluginCustomStorage = target.pluginCustomStorage || toSave.pluginCustomStorage
        target.root = target.root || toSave.root
    }

    function requeueTrackedChanges(toSave: toSaveType) {
        mergeTrackedChanges(changeTracker, toSave)
    }

    function collectChatsToPersist(db: Database, toSave: toSaveType): [string, string][] {
        const chatsToPersist: [string, string][] = []
        const seen = new Set<string>()
        const pushChat = (chaId: string, chatId: string) => {
            if (!chaId || !chatId) return
            const key = `${chaId}|${chatId}`
            if (seen.has(key)) return
            seen.add(key)
            chatsToPersist.push([chaId, chatId])
        }

        for (const [chaId, chatId] of toSave.chat) {
            pushChat(chaId, chatId)
        }

        for (const chaId of toSave.character) {
            const char = db.characters.find(c => c?.chaId === chaId)
            if (!char) continue
            const knownChatIds = knownChatIdsByCharacter.get(chaId) ?? new Set<string>()
            for (const chat of char.chats ?? []) {
                if (!chat?.id || chat._placeholder) continue
                if (!knownChatIds.has(chat.id)) {
                    pushChat(chaId, chat.id)
                }
            }
        }

        return chatsToPersist
    }

    function updateKnownChatsAfterSuccessfulSave(db: Database, toSave: toSaveType) {
        for (const chaId of toSave.character) {
            const char = db.characters.find(c => c?.chaId === chaId)
            if (!char) {
                knownChatIdsByCharacter.delete(chaId)
                continue
            }
            knownChatIdsByCharacter.set(
                chaId,
                new Set((char.chats ?? []).map(chat => chat?.id).filter(Boolean))
            )
        }

        for (const [chaId, chatId] of toSave.chat) {
            if (!chaId || !chatId) continue
            const knownChatIds = knownChatIdsByCharacter.get(chaId) ?? new Set<string>()
            knownChatIds.add(chatId)
            knownChatIdsByCharacter.set(chaId, knownChatIds)
        }
    }

    async function rebaseTrackedLocalChangesOnLatestServerDb(
        conflictEtag: string | null,
        db: Database,
        toSave: toSaveType,
        exactPatch?: any[],
    ) {
        forageStorage.setDbEtag(conflictEtag ?? null)
        const latestDb = isNodeServer
            ? (await forageStorage.getDatabaseProjection<Database>()).database
            : await (async () => {
                const latestData = await forageStorage.getItem('database/database.bin') as unknown as Uint8Array
                return latestData?.length ? await decodeRisuSave(latestData) as Database : null
            })()
        if (latestDb) {
            const preparedRebase = preparePatchConflictRebase(
                latestDb,
                exactPatch ? { patch: exactPatch, baseline: acceptedPatchBaseline! } : undefined,
            )
            const mergedDb = preparedRebase.mergedValue as Database
            const serverBaseline = preparedRebase.serverBaseline as Database
            const localDb = structuredClone(db) as Database

            if (!exactPatch) {
                // Full-write conflicts do not have a JSON Patch to replay.
                // Keep this fallback scoped to the blocks the save tracker
                // observed instead of copying every stale root block.
                if (toSave.root) {
                    for (const key in localDb) {
                        if (
                            key !== 'characters' && key !== 'botPresets' && key !== 'activePromptPresetId' && key !== 'modules' &&
                            key !== 'plugins' && key !== 'pluginCustomStorage'
                        ) {
                            mergedDb[key] = structuredClone(localDb[key])
                        }
                    }
                }

                if (toSave.botPreset) {
                    mergedDb.botPresets = structuredClone(localDb.botPresets)
                    mergedDb.activePromptPresetId = localDb.activePromptPresetId
                }
                if (toSave.modules) mergedDb.modules = structuredClone(localDb.modules)
                if (toSave.plugins) mergedDb.plugins = structuredClone(localDb.plugins)
                if (toSave.pluginCustomStorage) {
                    mergedDb.pluginCustomStorage = structuredClone(localDb.pluginCustomStorage)
                }

                const trackedCharIds = new Set<string>(toSave.character.filter(Boolean))
                for (const trackedChat of toSave.chat) {
                    if (trackedChat?.[0]) trackedCharIds.add(trackedChat[0])
                }
                const mergedCharacters = Array.isArray(mergedDb.characters) ? mergedDb.characters : []
                const localCharacters = Array.isArray(localDb.characters) ? localDb.characters : []

                for (const charId of trackedCharIds) {
                    const localChar = localCharacters.find((char) => char?.chaId === charId)
                    const mergedIndex = mergedCharacters.findIndex((char) => char?.chaId === charId)
                    if (localChar) {
                        const clonedLocalChar = structuredClone(localChar)
                        if (mergedIndex >= 0) mergedCharacters[mergedIndex] = clonedLocalChar
                        else mergedCharacters.push(clonedLocalChar)
                    }
                    else if (mergedIndex >= 0) mergedCharacters.splice(mergedIndex, 1)
                }
                mergedDb.characters = mergedCharacters
            }

            // The save baseline stays stub-only, but already hydrated local chat
            // bodies must survive in the live runtime DB.
            const localCharacters = new Map(
                (localDb.characters ?? []).map(character => [character.chaId, character] as const),
            )
            for (const character of mergedDb.characters ?? []) {
                const localCharacter = localCharacters.get(character.chaId)
                const localChats = new Map((localCharacter?.chats ?? []).map(chat => [chat?.id, chat]))
                character.chats = convertStubsToPlaceholders(character.chats ?? []).map(remoteChat => {
                    const localChat = localChats.get(remoteChat?.id)
                    return localChat && !localChat._placeholder
                        ? mergeHydratedChatWithMetadata(localChat, remoteChat)
                        : remoteChat
                })
            }
            // A conflict rebase is a server-state installation too. Running
            // this replacement outside the sync guard used to classify the
            // preserved hydrated body as a fresh client edit.
            syncApplying = true
            try {
                await replaceRuntimeDatabase(mergedDb)
            } finally {
                syncApplying = false
            }

            if (!isNodeServer) {
                encoder = new RisuSaveEncoder()
                await encoder.init(getDatabase())
            }
            if (isNodeServer) {
                patcher = new RisuSavePatcher()
                // The merged value contains changes that the server rejected.
                // Keep them live and dirty, but diff from the exact server
                // pre-image so the retry sends them again.
                await patcher.init(serverBaseline)
                acceptPatcherBaseline()
            }
        }
        requeueTrackedChanges(toSave)
        changed = true
    }

    async function persistTrackedChanges(
        toSave: toSaveType,
        options?: {
            forceFullWrite?: boolean
            skipBroadcast?: boolean
        }
    ): Promise<SaveAttemptResult> {
        const db = getDatabase()
        if (!db.characters) {
            await sleep(1000)
            return 'noop'
        }

        // A new relational character has no chat rows until its projection
        // patch is accepted. Defer those chat bodies until after the metadata
        // phase; established characters retain the normal chat-first order.
        const newCharacterIds = new Set(
            toSave.character.filter(chaId =>
                db.characters.some(character => character?.chaId === chaId)
                && !knownChatIdsByCharacter.has(chaId)
            )
        )
        const trackedChats = collectChatsToPersist(db, toSave)
        const deferredNewCharacterChats = isNodeServer
            ? trackedChats.filter(([chaId]) => newCharacterIds.has(chaId))
            : []
        const chatsBeforeProjection = deferredNewCharacterChats.length > 0
            ? trackedChats.filter(([chaId]) => !newCharacterIds.has(chaId))
            : trackedChats

        const failedChats: [string, string][] = []
        const chatErrors: unknown[] = []
        const persistChat = async (
            chaId: string,
            chatId: string,
            options?: { establishServerBaseline?: boolean },
        ) => {
            const char = db.characters.find(c => c.chaId === chaId)
            if (!char) return
            const chatIndex = char.chats.findIndex(c => c.id === chatId)
            if (chatIndex === -1) return
            const chat = char.chats[chatIndex]
            // Skip placeholders — they have no real data to save
            if (chat._placeholder) return
            try {
                if (options?.establishServerBaseline) {
                    const serverChat = await fetchChatFromServer(chaId, chatIndex, chatId)
                    if (!serverChat) {
                        throw new Error(`New chat metadata was not created for ${chaId}/${chatId}`)
                    }
                    rebaseChatWorkingCopy(
                        chaId,
                        chatId,
                        getChatServerEtag(chaId, chatId),
                    )
                }
                await saveChatToServer(chaId, chatIndex, chatId, chat, {
                    tracked: true,
                    getChat: () => getDatabase().characters
                        .find(character => character.chaId === chaId)?.chats
                        .find(current => current.id === chatId),
                })
            } catch (e) {
                if (
                    e instanceof ConflictError
                    && acknowledgeProjectionOnlyChatConflict(chaId, chat)
                ) {
                    if (e.currentEtag) setChatServerEtag(chaId, chatId, e.currentEtag)
                    window.dispatchEvent(new Event('risu-sync-refresh-requested'))
                    return
                }
                console.error(`[Save] Failed to save chat ${chaId}/${chatId}:`, e)
                failedChats.push([chaId, chatId])
                chatErrors.push(e)
            }
        }

        for (const [chaId, chatId] of chatsBeforeProjection) {
            await persistChat(chaId, chatId)
        }
        const hasIndependentProjectionChanges = !!(
            toSave.root ||
            toSave.botPreset ||
            toSave.modules ||
            toSave.plugins ||
            toSave.pluginCustomStorage ||
            toSave.character.length > 0
        )
        if (failedChats.length > 0 && !hasIndependentProjectionChanges) {
            throw new ChatSaveError(failedChats, false, chatErrors)
        }

        // Non-Node stores keep database.bin. The Node server takes the stub-only
        // delta instead, leaving database.bin to explicit import/export.
        let dbData: Uint8Array | null = null
        if (!isNodeServer) {
            await encoder!.set(db, structuredClone(toSave))
            const encoded = encoder!.encode()
            if (!encoded) {
                await sleep(1000)
                return 'noop'
            }
            dbData = new Uint8Array(encoded)
        }

        let saved = false
        let projectionUnchanged = false
        let newEtag: string | undefined

        if (isNodeServer) {
            await projectionDeltaSave.flush()
            const patchData = await patcher.set(db, structuredClone(toSave))
            // Refuse to send patches the server would reject: chat bodies go
            // through the chat endpoint. chatToStub strips chats to metadata
            // before diffing, so the only way these ops appear is a baseline
            // desync; refresh the projection and retry. The console.error is
            // the primary breadcrumb for tracking down the unknown root cause.
            const dangerous = findChatInternalFieldOps(patchData.patch)
            if (dangerous.length > 0) {
                // Always log a one-line summary so production environments
                // see enough to file a bug report. The rich dump below is
                // enabled by pnpm debug to keep repeated failures concise.
                const sampleOps = dangerous.slice(0, 3).map(d => `${d.op} ${d.path}`).join(', ')
                console.error(
                    `[Save] Patcher emitted ${dangerous.length} chat-internal field op(s) — `
                    + `refreshing projection baseline. sample: ${sampleOps}`
                    + ' (verbose dump: restart with pnpm debug and reload the page)'
                )
                showChatGuardToastThrottled('client')

                if (isDebugEnabled()) {
                const affectedChats: Record<string, any> = {}
                const seen = new Set<string>()
                const baselineCharsLen = (patcher as any).lastSyncedDb?.characters?.length ?? -1
                const currentCharsLen = db.characters?.length ?? -1

                const summarize = (c: any) => {
                    if (c == null) return null
                    const keys = Object.keys(c)
                    const keyShapes: Record<string, string> = {}
                    for (const k of keys) {
                        const v = c[k]
                        if (v === null) keyShapes[k] = 'null'
                        else if (Array.isArray(v)) keyShapes[k] = `Array(${v.length})`
                        else if (typeof v === 'object') keyShapes[k] = `Object(${Object.keys(v).length})`
                        else keyShapes[k] = `${typeof v}=${typeof v === 'string' && v.length > 30 ? v.slice(0, 30) + '…' : JSON.stringify(v)}`
                    }
                    return {
                        keys,
                        keyShapes,
                        classification: classifyChat(c),
                        _stub: c._stub,
                        _placeholder: c._placeholder,
                        hasMessage: Array.isArray(c.message),
                        messageLen: Array.isArray(c.message) ? c.message.length : null,
                        id: c.id,
                        name: c.name,
                        ctor: c?.constructor?.name,
                        isFrozen: Object.isFrozen(c),
                        isProxy: typeof c === 'object' && c !== null && (c as any)?.[Symbol.toStringTag] !== undefined,
                    }
                }

                const stubReplay = (c: any) => {
                    if (c == null) return null
                    try {
                        const result = chatToStub(c)
                        return summarize(result)
                    } catch (e) {
                        return { error: String(e) }
                    }
                }

                for (const op of dangerous) {
                    const m = op.path.match(/^\/characters\/(\d+)\/chats\/(\d+)\//)
                    if (!m) continue
                    const key = `${m[1]}/${m[2]}`
                    if (seen.has(key)) continue
                    seen.add(key)
                    if (seen.size > 5) break
                    const ci = +m[1], chi = +m[2]
                    const baselineChar = (patcher as any).lastSyncedDb?.characters?.[ci]
                    const currentChar = db.characters?.[ci]
                    const baselineChat = baselineChar?.chats?.[chi]
                    const currentChat = currentChar?.chats?.[chi]
                    const opsForThisChat = dangerous.filter(d => d.path.startsWith(`/characters/${ci}/chats/${chi}/`))
                    const refIdentity = {
                        sameCharacter: baselineChar === currentChar,
                        sameChatsArray: baselineChar?.chats === currentChar?.chats,
                        sameChatSlot: baselineChat === currentChat,
                    }
                    affectedChats[key] = {
                        characterContext: {
                            baselineChaId: baselineChar?.chaId,
                            currentChaId: currentChar?.chaId,
                            chaIdsMatch: baselineChar?.chaId === currentChar?.chaId,
                            baselineChatsLen: baselineChar?.chats?.length ?? -1,
                            currentChatsLen: currentChar?.chats?.length ?? -1,
                            refIdentity,
                        },
                        baselineChat: summarize(baselineChat),
                        currentChat: summarize(currentChat),
                        currentAfterChatToStub: stubReplay(currentChat),
                        baselineAfterChatToStub: stubReplay(baselineChat),
                        opsForThisChat,
                    }
                }

                const charsDistribution: Record<string, any> = {}
                for (const k of Array.from(seen).slice(0, 3)) {
                    const ci = +k.split('/')[0]
                    const baselineChats = (patcher as any).lastSyncedDb?.characters?.[ci]?.chats ?? []
                    const currentChats = db.characters?.[ci]?.chats ?? []
                    const tally = (chats: any[]) => {
                        const t = { total: chats.length, stub: 0, placeholder: 0, hybrid: 0, full: 0, neither: 0 }
                        for (const c of chats) {
                            if (!c) continue
                            const isStub = c._stub === true
                            const isPh = c._placeholder === true
                            const hasMsg = Array.isArray(c.message)
                            if (isStub && hasMsg) t.hybrid++
                            else if (isStub) t.stub++
                            else if (isPh) t.placeholder++
                            else if (hasMsg) t.full++
                            else t.neither++
                        }
                        return t
                    }
                    charsDistribution[`character[${ci}]`] = {
                        baseline: tally(baselineChats),
                        current: tally(currentChats),
                    }
                }

                console.debug('[Save:guard-debug] context:', {
                    baselineCharsLen,
                    currentCharsLen,
                    selectedCharID: selIdState.selId,
                    totalDangerousOps: dangerous.length,
                    uniqueAffectedChats: seen.size,
                })
                console.debug('[Save:guard-debug] all dangerous ops:', dangerous)
                console.debug('[Save:guard-debug] affected chats (baseline / current / stubReplay):', affectedChats)
                console.debug('[Save:guard-debug] chats[] distribution per affected character:', charsDistribution)
                }
                await rebaseTrackedLocalChangesOnLatestServerDb(null, db, toSave)
                return 'retry'
            } else if (
                patchData.patch.length === 0
                && patcher.hash() === acceptedPatchHash
            ) {
                // The patcher starts every save at the accepted projection
                // (pending deltas are flushed and failures reset it), so an empty
                // patch with an unchanged hash has nothing to send. Skipping it
                // avoids cloning and diffing the whole projection, which a
                // selection-only effect run (e.g. opening a chat) would trigger.
                saved = true
                projectionUnchanged = true
            } else {
                let patchResult
                try {
                    const baseline = patcher.getBaselineSnapshot()
                    patchResult = await projectionDeltaSave.save({ changes: createDelta(acceptedPatchBaseline, baseline) }, {
                        base: acceptedPatchBaseline,
                        local: baseline,
                        tracked: structuredClone(toSave),
                    })
                } catch (error) {
                    // RisuSavePatcher advances its in-memory baseline while it
                    // builds a patch. Until the response is acknowledged, retain
                    // the last accepted projection; DeltaSave replays an uncertain
                    // request before creating the next delta.
                    await resetPatcherToAcceptedBaseline()
                    throw error
                }
                saved = patchResult.success
                if (patchResult.etag) {
                    newEtag = patchResult.etag
                    forageStorage.setDbEtag(patchResult.etag)
                }
                // Server's chat-internal-field guard rejected the patch — the
                // client-side guard above missed this case. Surface to user;
                // the failed save below resets the baseline.
                if (patchResult.chatGuardRejected) {
                    console.error('[Save] Server rejected patch — chat-internal field ops detected server-side')
                    showChatGuardToastThrottled('server')
                }
                if (patchResult.conflict) {
                    console.warn('[Save] Patch conflict; rebasing pending changes', {
                        code: patchResult.conflictCode,
                        revision: patchResult.revision,
                    })
                    await rebaseTrackedLocalChangesOnLatestServerDb(
                        patchResult.etag ?? null,
                        db,
                        toSave,
                        patchData.patch,
                    )
                    return 'retry'
                }
            }
        }
        if (!saved) {
            if (isNodeServer) {
                await resetPatcherToAcceptedBaseline()
                throw new Error('Database projection patch failed')
            }
            try {
                const currentEtag = forageStorage.getDbEtag()
                await forageStorage.setItem('database/database.bin', dbData!, currentEtag ?? undefined)
            } catch (conflictErr) {
                if (conflictErr instanceof ConflictError) {
                    console.warn('[Save] Full-write conflict detected, rebasing tracked local changes on latest server DB...')
                    await rebaseTrackedLocalChangesOnLatestServerDb(conflictErr.currentEtag ?? null, db, toSave)
                    return 'retry'
                }
                throw conflictErr
            }
        }

        if (isNodeServer) {
            // The projection is now acknowledged even if a deferred chat body
            // later fails in transport. Imported chats already own stable ids,
            // so the patcher's normalized local projection is the server shape.
            if (!projectionUnchanged) acceptPatcherBaseline()
        }

        for (const [chaId, chatId] of deferredNewCharacterChats) {
            await persistChat(chaId, chatId, { establishServerBaseline: true })
        }

        updateKnownChatsAfterSuccessfulSave(db, toSave)

        if (newEtag) {
            forageStorage.setDbEtag(newEtag)
        }

        // A stale or conflicting chat body must not roll back an unrelated
        // settings/module projection that the server already accepted.
        if (failedChats.length > 0) {
            throw new ChatSaveError(failedChats, true, chatErrors)
        }

        return 'saved'
    }

    const saveRetry = new SaveRetryPolicy()

    async function triggerSave(options?: {
        forceFullWrite?: boolean
        skipBroadcast?: boolean
        requireSuccess?: boolean
    }): Promise<void> {
        if (syncApplying) {
            if (options?.requireSuccess) throw new SaveConflictError()
            return
        }
        if (saveInFlight) {
            await saveInFlight
            // Shared autosave promises absorb errors; exports must verify a successful attempt.
            if (options?.requireSuccess) return triggerSave(options)
            return
        }

        const toSave = takeTrackedChanges()
        if (!hasTrackedChanges(toSave) && !options?.forceFullWrite) {
            return
        }

        let failure: { error: unknown } | undefined
        saveInFlight = (async () => {
            saving.state = true
            try {
                const result = await saveRetry.runAttempt(() => persistTrackedChanges(toSave, options))
                if (result === 'noop' && hasTrackedChanges(toSave)) {
                    if (options?.requireSuccess) throw new SaveConflictError()
                    requeueTrackedChanges(toSave)
                    changed = true
                }
            } catch (error) {
                if (error instanceof ChatSaveError && error.projectionSaved) {
                    const failedKeys = new Set(error.failedChats.map(([characterId, chatId]) => `${characterId}|${chatId}`))
                    changeTracker.chat = [
                        ...error.failedChats,
                        ...changeTracker.chat.filter(([characterId, chatId]) => !failedKeys.has(`${characterId}|${chatId}`)),
                    ]
                } else {
                    requeueTrackedChanges(toSave)
                }
                if (options?.requireSuccess) {
                    saveRetry.reset()
                    changed = true
                    failure = { error }
                    return
                }
                const decision = saveRetry.recordFailure(error)
                if (!decision.retry) {
                    // Preserve dirty targets, but stop both the retry loop and
                    // a debounce scheduled before this failure. A later edit
                    // or explicit save can retry with a fresh budget.
                    cancelPendingSave()
                    changed = false
                    saveRetry.reset()
                    if (!isCancelledSaveConflict(error)) alertError(error)
                }
                else {
                    if (!(error instanceof SaveConflictError)) console.error(error)
                    await sleep(decision.delayMs)
                    changed = true
                }
            } finally {
                saving.state = false
                saveInFlight = null
            }
        })()

        await saveInFlight
        if (failure) throw failure.error
        // A strict caller must also persist edits that arrived while this
        // attempt was in flight before it can safely export the current state.
        if (options?.requireSuccess && hasTrackedChanges(changeTracker)) {
            return triggerSave(options)
        }
    }

    requestImmediateSaveImpl = async (options) => {
        // An immediate save must include the changes requested by this call,
        // even when it arrives while an earlier save is still finishing.
        if (saveInFlight) await saveInFlight
        for (const characterId of options?.characterIds ?? []) {
            if (characterId) {
                changeTracker.character = [
                    characterId,
                    ...changeTracker.character.filter((trackedId) => trackedId !== characterId),
                ]
            }
        }
        for (const target of options?.chatTargets ?? []) {
            if (!target.characterId || !target.chatId) continue
            changeTracker.chat = [
                [target.characterId, target.chatId],
                ...changeTracker.chat.filter(([characterId, chatId]) =>
                    characterId !== target.characterId || chatId !== target.chatId),
            ]
        }
        changed = true
        await tick()
        await triggerSave({
            forceFullWrite: options?.forceFullWrite,
            requireSuccess: options?.requireSuccess,
        })
    }

    if (onReady) {
        // Initialize reactive dirty tracking before startup migrations edit the database.
        await tick()
        await onReady()
    }

    while (true) {
        if (!changed) {
            await sleep(200)
            continue
        }
        changed = false
        if (requiresFullEncoderReload.state) {
            if (!isNodeServer) {
                encoder = new RisuSaveEncoder()
                await encoder.init(getDatabase())
            }
            requiresFullEncoderReload.state = false
        }
        await triggerSave()
        await sleep(100)
    }
}

export async function getDbBackups(currentDbSize?: number) {
    const keys = await forageStorage.keys()

    const backups = keys
        .filter(key => key.startsWith('database/dbbackup-'))
        .map(key => parseInt(key.slice(18, -4)))
        .sort((a, b) => b - a);

    const BACKUP_BUDGET = 500 * 1024 * 1024
    const maxBackups = currentDbSize
        ? Math.min(20, Math.max(3, Math.floor(BACKUP_BUDGET / currentDbSize)))
        : 20

    while (backups.length > maxBackups) {
        const last = backups.pop()
        await forageStorage.removeItem(`database/dbbackup-${last}.bin`)
    }
    return backups
}

export async function getFetchData(id: string): Promise<FetchLog | null> {
    for (const log of fetchLog) {
        if (log.chatId === id) {
            return log;
        }
    }
    try {
        return await getServerFetchLogByChatIdRequest(
            id,
            () => forageStorage.createAuth(),
        );
    } catch {
        // Non-Node/browser-only environments have no persistent request-log API.
        return null;
    }
}

export function getBasename(data: string) {
    return data.replace(/\\/g, '/').split('/').pop()!;
}


export function checkCharOrder() {
    const db = getDatabase()
    db.characterOrder = db.characterOrder ?? []
    if (db.hiddenCharacterIds?.length) {
        const knownIds = new Set(db.characters.map(character => character.chaId))
        const hiddenIds = [...new Set(db.hiddenCharacterIds)].filter(id => knownIds.has(id))
        if (hiddenIds.length !== db.hiddenCharacterIds.length) db.hiddenCharacterIds = hiddenIds
    }
    const orderedIds = new Set<string>()
    for (let i = 0; i < db.characterOrder.length; i++) {
        const folder = db.characterOrder[i]
        if (typeof (folder) !== 'string' && folder) {
            for (const f of folder.data) {
                orderedIds.add(f)
            }
        }
        if (typeof (folder) === 'string') {
            orderedIds.add(folder)
        }
    }

    const charIds = new Set<string>()

    for (let i = 0; i < db.characters.length; i++) {
        const char = db.characters[i]
        const charId = char.chaId
        if (!char.trashTime) {
            charIds.add(charId)
        }
        if (!orderedIds.has(charId)) {
            if (charId !== '§temp' && !char.trashTime) {
                db.characterOrder.push(charId)
            }
        }
    }


    for (let i = 0; i < db.characterOrder.length; i++) {
        const data = db.characterOrder[i]
        if (typeof (data) !== 'string') {
            if (!data) {
                db.characterOrder.splice(i, 1)
                i--;
                continue
            }
            for (let i2 = 0; i2 < data.data.length; i2++) {
                const data2 = data.data[i2]
                if (!charIds.has(data2)) {
                    data.data.splice(i2, 1)
                    i2--;
                }
            }
            if (data.data.length === 0) {
                db.characterOrder.splice(i, 1)
                i--;
                continue
            }
            db.characterOrder[i] = data
        }
        else {
            if (!charIds.has(data)) {
                db.characterOrder.splice(i, 1)
                i--;
            }
        }
    }


}

export function getFetchLogs() {
    return fetchLog
}

export function clearFetchLogs(scope: RequestLogClearScope) {
    if (scope === 'all') {
        fetchLog = []
        return
    }
    fetchLog = fetchLog.map(log => ({
        ...log,
        body: '',
        header: '',
        response: '',
        payloadAvailable: false,
    }))
}

export function deleteFetchLog(id: string) {
    fetchLog = fetchLog.filter(log => log.id !== id)
}

export async function getServerFetchLogs(options: { limit?: number; beforeId?: string } = {}): Promise<FetchLogPage> {
    return getServerFetchLogsRequest(() => forageStorage.createAuth(), options)
}

export async function getServerFetchLogById(id: string): Promise<FetchLog> {
    return getServerFetchLogByIdRequest(id, () => forageStorage.createAuth())
}

export async function clearServerFetchLogs(scope: RequestLogClearScope) {
    return clearServerFetchLogsRequest(() => forageStorage.createAuth(), scope)
}

export async function setServerFetchLogLimit(maxBytes: number) {
    return setServerFetchLogLimitRequest(() => forageStorage.createAuth(), maxBytes)
}

export async function deleteServerFetchLog(id: string) {
    return deleteServerFetchLogRequest(id, () => forageStorage.createAuth())
}

export function openURL(url: string) {
    window.open(url, "_blank")
}

export class LocalWriter {
    writer: WritableStreamDefaultWriter

    async init(name = 'Binary', ext = ['bin']): Promise<boolean> {
        const writableStream = streamSaver.createWriteStream(name + '.' + ext[0])
        this.writer = writableStream.getWriter()
        return true
    }

    async writeBackup(name: string, data: Uint8Array): Promise<void> {
        const encodedName = new TextEncoder().encode(getBasename(name))
        const nameLength = new Uint32Array([encodedName.byteLength])
        await this.writer.write(new Uint8Array(nameLength.buffer))
        await this.writer.write(encodedName)
        const dataLength = new Uint32Array([data.byteLength])
        await this.writer.write(new Uint8Array(dataLength.buffer))
        await this.writer.write(data)
    }

    async write(data: Uint8Array): Promise<void> {
        await this.writer.write(data)
    }

    async close(): Promise<void> {
        await this.writer.close()
    }
}

export class VirtualWriter {
    buf = new AppendableBuffer()

    write(data: Uint8Array): void {
        this.buf.append(data)
    }

    /** Closing is a no-op so this matches the writer interface. */
    close(): void {
    }
}

/** Buffer that supports absolute-offset reads after discarding leading bytes. */
export class AppendableBuffer {
    deapended: number = 0
    #buffer: Uint8Array
    #byteLength: number = 0

    constructor() {
        this.#buffer = new Uint8Array(128)
    }

    get buffer(): Uint8Array {
        return this.#buffer.slice(0, this.#byteLength)
    }

    append(data: Uint8Array) {
        const requiredLength = this.#byteLength + data.length
        if (this.#buffer.byteLength < requiredLength) {
            let newLength = this.#buffer.byteLength * 2
            while (newLength < requiredLength) {
                newLength *= 2
            }
            const newBuffer = new Uint8Array(newLength)
            newBuffer.set(this.#buffer)
            this.#buffer = newBuffer
        }
        this.#buffer.set(data, this.#byteLength)
        this.#byteLength += data.length
    }

    /** Discard leading bytes while preserving absolute offsets for slice(). */
    deappend(length: number) {
        this.#buffer = this.#buffer.slice(length)
        this.deapended += length
        this.#byteLength -= length
    }

    /** Slice using absolute offsets, including bytes already deappended. */
    slice(start: number, end: number) {
        return this.buffer.slice(start - this.deapended, end - this.deapended)
    }

    length() {
        return this.#byteLength + this.deapended
    }

    clear() {
        this.#buffer = new Uint8Array(128)
        this.#byteLength = 0
        this.deapended = 0
    }
}

/** No-op writer for APIs that require the common writer interface. */
export class BlankWriter {
    constructor() {
    }

    async init() {
    }

    async write(key: string, data: Uint8Array | string) {
    }

    async end() {
    }
}

export async function loadInternalBackup() {

    const keys = await forageStorage.keys()
    const internalBackups = keys
        .filter((key) => key.startsWith('database/dbbackup-'))
        .sort((a, b) => {
            const aTs = parseInt(a.replace('database/dbbackup-', '').replace('.bin', ''))
            const bTs = parseInt(b.replace('database/dbbackup-', '').replace('.bin', ''))
            return bTs - aTs
        })

    const selectOptions = [
        'Cancel',
        ...(internalBackups.map((a) => {
            return (new Date(parseInt(a.replace('database/dbbackup-', '').replace('dbbackup-', '')) * 100)).toLocaleString()
        }))
    ]

    const selectedOption = parseInt(await alertSelect(selectOptions))
    if (selectedOption <= 0) {
        return
    }
    const alertResult = selectedOption - 1

    const selectedBackup = internalBackups[alertResult]

    const data = await forageStorage.getItem(selectedBackup)

    const backupDecoded = await decodeRisuSave(Buffer.from(data) as unknown as Uint8Array)
    setDatabase(backupDecoded)

    notifySuccess('Loaded backup')



}

export function getVersionString(): string {
    return pocketKeiVer
}

export function toGetter<T extends object>(
    getterFn: () => T,
    args?: {
        restrictChildren:string[]
    }
): T {

    const dummyTarget = () => { };

    return new Proxy(dummyTarget, {
        get(target, prop, receiver) {

            const realInstance = getterFn();
            
            if (args?.restrictChildren && args.restrictChildren.includes(prop as string)) {
                throw new Error(`Access to property '${String(prop)}' is restricted`);
            }

            if (realInstance === null || realInstance === undefined) {
                return (realInstance as any)[prop];
            }

            const value = Reflect.get(realInstance as object, prop);

            if (typeof value === 'function') {
                return value.bind(realInstance);
            }

            return value;
        },

        set(target, prop, value, receiver) {

            if(args?.restrictChildren && args.restrictChildren.includes(prop as string)) {
                throw new Error(`Access to property '${String(prop)}' is restricted`);
            }
            const realInstance = getterFn();
            return Reflect.set(realInstance as object, prop, value, receiver);
        },

        has(target, prop) {
            const realInstance = getterFn();
            return Reflect.has(realInstance as object, prop);
        },

        ownKeys(target) {
            const realInstance = getterFn();
            return Reflect.ownKeys(realInstance as object);
        },

        construct(target, argArray, newTarget) {
            const realInstance = getterFn() as any;
            return new realInstance(...argArray);
        },

        deleteProperty(target, prop) {
            const realInstance = getterFn();
            return Reflect.deleteProperty(realInstance as object, prop);
        },

        getPrototypeOf() {
            const realInstance = getterFn();
            return Reflect.getPrototypeOf(realInstance as object);
        }
    }) as unknown as T;
}

export function aiLawApplies(): boolean {

    //TODO: implement actual logic
    //lets now assume it always applies
    //so we don't have legal issues later

    return true
}

export function aiWatermarkingLawApplies(): boolean {

    //TODO: implement actual logic
    //lets now assume it is false for now,
    //becuase very few countries have it for now
    return false
}

export const chatFoldedState = $state<{
    data: null| {
        targetCharacterId: string,
        targetChatId: string,
        targetMessageId: string,
    }
}>({
    data: null
})

//Since its exported, we cannot use $derived here
export let chatFoldedStateMessageIndex = $state({
    index: -1
})

$effect.root(() => {
    $effect(() => {
        if(!chatFoldedState.data){
            return
        }
        const char = DBState.db.characters[selIdState.selId]
        const chat = char.chats[getChatPage(char)]
        if(chatFoldedState.data.targetCharacterId !== char.chaId){
            chatFoldedState.data = null
        }
        if(chatFoldedState.data.targetChatId !== chat.id){
            chatFoldedState.data = null
        }
    })

    $effect(() => {
        if(chatFoldedState.data === null){
            chatFoldedStateMessageIndex.index = -1
            return
        }
        const char = DBState.db.characters[selIdState.selId]
        const chat = char.chats[getChatPage(char)]
        const messageIndex = chat.message.findIndex((v) => {
            return chatFoldedState.data?.targetMessageId === v.chatId
        })
        if(messageIndex === -1){
            console.warn('Target message for folding id' + chatFoldedState.data?.targetMessageId + ' not found')
            chatFoldedStateMessageIndex.index = -1
            return
        }
        chatFoldedStateMessageIndex.index = messageIndex
    })
})

export function foldChatToMessage(targetMessageIdOrIndex: string | number) {
    let targetMessageId = ''
    if (typeof targetMessageIdOrIndex === 'number') {
        const char = getCurrentCharacter()
        const chat = char.chats[getChatPage(char)]
        const message = chat.message[targetMessageIdOrIndex]
        targetMessageId = message.chatId
    }
    else{
        targetMessageId = targetMessageIdOrIndex
    }
    const char = getCurrentCharacter()
    const chat = char.chats[getChatPage(char)]
    chatFoldedState.data = {
        targetCharacterId: char.chaId,
        targetChatId: chat.id,
        targetMessageId: targetMessageId,
    }
}

/**
 * Hydrate a just-selected placeholder chat behind a cancellable loading overlay.
 * Toggles load only if the same character and chat are still active afterwards.
 */
export function hydrateSelectedChat(char: character, index: number, source: string) {
    const capturedCharacterId = char.chaId
    const capturedChatId = char.chats[index].id
    let cancelled = false
    const releaseOverlay = claimLoadingOverlay(language.loading ?? '', () => {
        cancelled = true
        chatDeselected.set(true)
        releaseOverlay()
    })
    void ensureChatHydrated(char, index).then((hydrated) => {
        if(cancelled) return
        const activeCharacter = DBState.db.characters[get(selectedCharID)]
        const activeChat = activeCharacter?.chats[getChatPage(activeCharacter)]
        if (
            hydrated
            && activeCharacter?.chaId === capturedCharacterId
            && activeChat?.id === capturedChatId
            && !activeChat._placeholder
        ) {
            loadTogglesFromChat(activeChat)
        }
    }).catch((e) => {
        console.error(`[${source}] hydration failed:`, e)
    }).finally(() => {
        if(!cancelled) releaseOverlay()
    })
}

export function changeChatTo(IdOrIndex: string | number) {
    let index = -1
    if (typeof IdOrIndex === 'number') {
        index = IdOrIndex
    }

    if (typeof IdOrIndex === 'string') {
        const currentCharacter = getCurrentCharacter()
        index = currentCharacter.chats.findIndex((v) => {
            return v.id === IdOrIndex
        })
    }

    if(index === -1){
        return
    }

    chatDeselected.set(false)
    const char = DBState.db.characters[selIdState.selId]
    const newChat = char.chats[index]
    setChatPage(char, index)
    if(newChat){
        dismissClaimedLoadingOverlay()
        if(newChat._placeholder){
            hydrateSelectedChat(char, index, 'changeChatTo')
        } else {
            loadTogglesFromChat(newChat)
        }
    }
    invalidateChatRoom()
}

export function createChatCopyName(
    originalName: string,
    type: 'Copy'|'Branch',
    chats = getCurrentCharacter().chats,
): string {
    let name = originalName.replaceAll(/\(((Copy|Branch)( \d+)?)\)$/g, '').trim()
    let copyIndex = 1
    let newName = `${name} (${type})`
    while (chats.find((v) => v.name === newName)) {
        copyIndex++
        newName = `${name} (${type} ${copyIndex})`
    }
    return newName
}

export async function createPersistedChatCopy(
    character: character,
    source: Chat,
    type: 'Copy' | 'Branch',
    prepare?: (copy: Chat) => void,
): Promise<Chat> {
    const sourceMessageIds = source.message.map(message => message.chatId)
    const copy = normalizeChat(cloneChatValue(source))
    copy.name = createChatCopyName(copy.name, type, character.chats)
    copy.id = createEntityId()
    prepare?.(copy)
    reissueMessageIds(copy, sourceMessageIds)

    return createPersistedChat(character, copy)
}

export async function createPersistedChat(
    character: character,
    chat: Chat,
): Promise<Chat> {
    character.chats.unshift(chat)
    // Enter immediately. The per-chat save queue snapshots later edits only
    // after this creation commit has acknowledged its canonical ETag.
    changeChatTo(chat.id)

    markChatWorkingCopyDirty(character.chaId, chat.id)
    await saveChatToServer(character.chaId, 0, chat.id, chat)
    await requestImmediateSave({ characterIds: [character.chaId] })
    return chat
}
