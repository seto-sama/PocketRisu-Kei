import { afterEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => {
    const database: any = {
        characters: [{
            chaId: 'character-1',
            chats: [{ id: 'chat-1', message: [], name: 'Chat' }],
        }],
        botPresets: [{ id: 'preset-1', name: 'Preset' }],
        activePromptPresetId: 'preset-1',
        modules: [],
        plugins: [],
        pluginCustomStorage: {},
    }
    const dbState: { db: any } = { db: database }
    let selectedId = 0
    const selectedCharID = {
        subscribe(run: (value: number) => void) {
            run(selectedId)
            return () => {}
        },
        set(value: number) { selectedId = value },
    }
    const patchDatabase = vi.fn(async () => ({ success: true, etag: 'etag-1', revision: 1 }))
    const savedChatSnapshots: any[] = []
    const saveChatToServer = vi.fn(async (_characterId: string, _chatIndex: number, _chatId: string, chat: any) => {
        savedChatSnapshots.push(structuredClone(chat))
    })
    return { database, dbState, selectedCharID, patchDatabase, saveChatToServer, savedChatSnapshots, saveLoopReady: false }
})

vi.mock('./stores.svelte', () => ({
    DBState: mocks.dbState,
    selectedCharID: mocks.selectedCharID,
    loadedStore: { set() {}, subscribe() { return () => {} } },
    LoadingStatusState: { text: '' },
    selIdState: { selId: 0 },
    ReloadGUIPointer: { update() {} },
    ChatRoomReloadPointer: { update() {} },
    bodyIntercepterStore: { set() {} },
    claimLoadingOverlay: () => '',
    dismissClaimedLoadingOverlay() {},
    chatDeselected: { set() {} },
    botMakerMode: { subscribe() { return () => {} } },
}))

vi.mock('./storage/database.svelte', () => ({
    getDatabase: () => mocks.dbState.db,
    setDatabase: (database: unknown) => { mocks.dbState.db = database },
    getCurrentCharacter: () => mocks.dbState.db.characters[0],
    pocketKeiVer: 'test',
    loadTogglesFromChat() {},
    normalizeChat: (chat: unknown) => chat,
}))

vi.mock('./storage/autoStorage', () => ({
    forageStorage: {
        getDbRevision: () => 0,
        getDbEtag: () => null,
        setDbEtag() {},
        patchDatabase: mocks.patchDatabase,
    },
}))

vi.mock('./storage/risuSave', () => ({
    RisuSaveEncoder: class {},
    RisuSavePatcher: class {
        private baseline: unknown
        async init(database: unknown) { this.baseline = structuredClone(database) }
        getBaselineSnapshot() { return structuredClone(this.baseline) }
        async set(database: unknown) {
            this.baseline = structuredClone(database)
            return { patch: [], expectedHash: 'hash' }
        }
    },
    calculateHash: () => 0,
    decodeRisuSave: async () => ({}),
    encodeRisuSaveLegacy: () => new Uint8Array(),
    findDangerousChatOps: () => [],
}))

vi.mock('./platform', () => ({ isNodeServer: true, supportsPatchSync: false }))
vi.mock('./storage/chatSelection.svelte', () => ({ getChatPage: () => 0, setChatPage() {} }))
vi.mock('./storage/chatStorage', () => ({
    saveChatToServer: mocks.saveChatToServer,
    chatToStub: (chat: unknown) => chat,
    convertStubsToPlaceholders: (chats: unknown[]) => chats,
    fetchChatFromServer: async () => null,
    getChatServerEtag: () => undefined,
    isHydrating: () => false,
    ensureChatHydrated: async () => {},
    classifyChat: () => 'full',
    setChatServerEtag() {},
    mergeHydratedChatWithMetadata: (_local: unknown, remote: unknown) => remote,
}))
vi.mock('./storage/chatWorkingCopy', () => ({
    discardAllChatWorkingCopies() {},
    discardAllChatGenerationProjections() {},
    consumeChatSyncApplied: () => false,
    listDirtyChatWorkingCopies: () => [],
    markChatWorkingCopyDirty() {},
    markChatSyncApplied() {},
    observeChatGenerationProjection: () => 'unchanged',
    pruneChatServerStates() {},
    rebaseChatWorkingCopy() {},
}))
vi.mock('./storage/nodeStorage', () => ({
    ConflictError: class ConflictError extends Error {},
    getSyncClientId: () => 'test-client',
}))
vi.mock('./sync/databaseSync', () => ({
    registerSyncedDatabaseHandler() {},
    reconcileHydratedChats() {},
}))
vi.mock('./util', () => ({
    checkNullish: (value: unknown) => value === null || value === undefined,
    sleep: () => {
        mocks.saveLoopReady = true
        return new Promise<void>(() => {})
    },
}))
vi.mock('./gui/deepTouch.svelte', () => ({ deepTouch() {} }))
vi.mock('./process/revenant/transport', () => ({ configureRevenantGenerationClient() {} }))

const { requestImmediateSave, saveDb } = await import('./globalApi.svelte')

describe('saveDb immediate saves', () => {
    afterEach(() => {
        mocks.patchDatabase.mockClear()
        mocks.saveChatToServer.mockClear()
        mocks.savedChatSnapshots.length = 0
    })

    it('persists a chat edit submitted by an immediate save while another is in flight', async () => {
        let finishFirstWrite: (() => void) | undefined
        let writeCount = 0
        mocks.patchDatabase
            .mockImplementationOnce(() => new Promise(resolve => {
                finishFirstWrite = () => {
                    writeCount += 1
                    resolve({ success: true, etag: 'etag-1', revision: 1 })
                }
            }))
            .mockImplementation(async () => {
                writeCount += 1
                if (writeCount > 3) throw new Error('bounded regression writes exceeded')
                return { success: true, etag: `etag-${writeCount}`, revision: writeCount }
            })

        let startupError: unknown
        void saveDb().catch(error => { startupError = error })
        // Let saveDb install requestImmediateSave and enter its idle loop.
        await vi.waitFor(() => expect(mocks.saveLoopReady).toBe(true))

        const firstSave = requestImmediateSave({
            characterIds: ['character-1'],
            chatTargets: [{ characterId: 'character-1', chatId: 'chat-1' }],
            requireSuccess: true,
        })
        await vi.waitFor(() => {
            if (startupError) throw startupError
            expect(finishFirstWrite).toBeTypeOf('function')
        })

        mocks.dbState.db.characters[0].chats[0].message.push({ data: 'edited while saving' })
        const secondSave = requestImmediateSave({
            characterIds: ['character-1'],
            chatTargets: [{ characterId: 'character-1', chatId: 'chat-1' }],
            requireSuccess: true,
        })

        finishFirstWrite!()
        await Promise.all([firstSave, secondSave])

        expect(mocks.patchDatabase).toHaveBeenCalledTimes(2)
        expect(mocks.saveChatToServer).toHaveBeenCalledTimes(2)
        expect(mocks.savedChatSnapshots[0].message).toEqual([])
        expect(mocks.savedChatSnapshots[1].message).toEqual([{ data: 'edited while saving' }])
    }, 3000)
})
