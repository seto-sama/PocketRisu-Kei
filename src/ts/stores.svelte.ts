import { getChatPage } from 'src/ts/storage/chatSelection.svelte'
import { fromStore, get, writable } from "svelte/store";
import type { character, Database } from "./storage/database.svelte";
import { type simpleCharacterArgument } from "./parser/parser.svelte";
import type { alertData } from "./alert";
import { moduleUpdate } from "./process/modules";
import { deepTouch } from "./gui/deepTouch.svelte";
import { resetScriptCache } from "./process/scripts";
import { INPUT_COMMIT_DEBOUNCE_MS } from './inputCommit'
import type { PopupEditorCommitMode, PopupEditorCommitResult } from './popupEditorCommit'
import { lgViewport } from './gui/breakpoints'
import type { language } from 'src/lang'

export const loadedStore = writable(false)
// Below Tailwind's lg breakpoint the sidebar overlays the chat instead of docking.
export const DynamicGUI = { get current() { return !lgViewport.current } }
export const sideBarClosing = writable(false)
export const sideBarStore = writable(lgViewport.current)
export const leftBarCollapsed = writable(false)
export const selectedCharID = writable(-1)
export const chatDeselected = writable(false)
export const sidebarDevTool = writable(false)
// Session-only DevTool state. Keeping this outside the component preserves the
// autopilot draft while its sidebar tab is unmounted and mounted again.
export const devToolAutopilotStore = writable<string[]>([])
export const CurrentTriggerIdStore = writable<string | null>(null)
export const settingsOpen = writable(false)
export const botMakerMode = writable(false)
export const moduleBackgroundEmbedding = writable('')
export const openPresetList = writable(false)
// Binding pickers pass an empty ID to clear the current chat's binding.
export const presetSelectCallback = writable<((id: string) => void) | null>(null)
export const openModelPresetList = writable(false)
export const requestPreviewOpen = writable(false)
export const openModelProfileBrowser = writable(false)
// When set to a preset id, the profile browser replaces that preset's profile
// (migrating matching userValues) instead of creating a new preset. null = create.
export const modelProfileReplaceTarget = writable<string | null>(null)
// Set to a newly-created preset id so the ModelPreset settings page opens it
// for editing immediately. Consumed (cleared) by ModelPresetSettings.
export const openModelPresetEditId = writable<string | null>(null)
export const openModuleListStore = writable(false)
export const openThemePresetList = writable(false)
export const openPersonaList = writable(false)
// Binding pickers pass -1 to clear the current chat's binding.
export const personaSelectCallback = writable<((index: number) => void) | null>(null)
export const openHypaV3PresetList = writable(false)
export const bookmarkListOpen = writable(false)
export const SettingsMenuIndex = writable(-1)
export interface BootBackupPromptData {
    estimate: number | null
    free: number | null
    total: number | null
    insufficient: boolean
    resolve: (mode: 'skip' | 'snapshot' | 'full') => void
}
export const bootBackupPromptStore = writable<BootBackupPromptData | null>(null)

// Stores rather than component state so routing and settings search can open a page on a given tab.
export const AddonSubmenuIndex = writable(0)
export const SystemSubmenuIndex = writable(0)
export const AdminStatsSubmenuIndex = writable(0)
export const AccessibilitySubmenuIndex = writable(0)
export const HotkeySubmenuIndex = writable(0)
export const DisplaySubmenuIndex = writable(0)
export const AdvancedSubmenuIndex = writable(0)
export const LanguageSubmenuIndex = writable(0)
export const PromptPresetSubmenuIndex = writable(0)
export const OtherBotsSubmenuIndex = writable(0)
export const InlayGallerySubmenuIndex = writable(0)
export const ModelPresetListTabIndex = writable(0)

// Message and background rendering runs through async regex/CBS/Lua pipelines
// whose inputs Svelte cannot track, so script APIs (Lua `reloadDisplay` /
// `reloadChat`, trigger `v2UpdateGUI` / `v2UpdateChatAt`) and edits that change
// rendered output bump these revisions explicitly.
let displayRevision = $state(0)
let chatRoomRevision = $state(0)
let messageRevisions = $state.raw<Record<number, number>>({})

export const renderRevision = {
    get display() { return displayRevision },
    get chatRoom() { return chatRoomRevision },
    get messages() { return messageRevisions },
}

function resetChatRenderState() {
    messageRevisions = {}
    resetScriptCache()
}

/** Re-renders every message and the background HTML. */
export function invalidateDisplay() {
    resetChatRenderState()
    displayRevision++
}

// Room switches need background/script-cache refreshes, but they must not
// invalidate every room's parsed-message cache like a real GUI/script edit.
export function invalidateChatRoom() {
    resetChatRenderState()
    chatRoomRevision++
}

export function invalidateChatMessageRender(messageIndex: number) {
    messageRevisions = {
        ...messageRevisions,
        [messageIndex]: (messageRevisions[messageIndex] ?? 0) + 1,
    }
}

export const ScrollToMessageStore = $state({
    value: -1,
    exact: false,
    targetCharacterId: '',
    targetChatId: '',
    targetMessageId: '',
})

export function requestMessageScroll(request: {
    index: number
    exact?: boolean
    characterId?: string
    chatId?: string
    messageId?: string
}) {
    // Write the numeric trigger last so reactive consumers always observe a
    // complete target identity when the request becomes active.
    ScrollToMessageStore.exact = request.exact ?? false
    ScrollToMessageStore.targetCharacterId = request.characterId ?? ''
    ScrollToMessageStore.targetChatId = request.chatId ?? ''
    ScrollToMessageStore.targetMessageId = request.messageId ?? ''
    ScrollToMessageStore.value = request.index
}

export function clearMessageScrollRequest() {
    ScrollToMessageStore.value = -1
    ScrollToMessageStore.exact = false
    ScrollToMessageStore.targetCharacterId = ''
    ScrollToMessageStore.targetChatId = ''
    ScrollToMessageStore.targetMessageId = ''
}
export const OpenRealmStore = writable(false)
export const HideIconStore = writable(false)
export const CustomCSSStore = writable('')
export const SafeModeStore = writable(false)
export const CharConfigSubMenu = writable(0)
export const alertStore = writable({
    type: 'none',
    msg: 'n',
} as alertData)
export const hypaV3ModalOpen = writable(false)
// Toggle preset selector lives outside alertStore so child alertConfirm /
// alertInput overlays can layer on top of it without overwriting state.
export const togglePresetsOpenStore = writable(false)
export const hypaV3ProgressStore = writable({
    open: false,
    miniMsg: '',
    msg: '',
    subMsg: '',
})
const selectedCharIDState = fromStore(selectedCharID)
// Reactive view of `selectedCharID` for `.svelte.ts` code that cannot use `$selectedCharID`.
export const selIdState = {
    get selId() { return selectedCharIDState.current },
}


CustomCSSStore.subscribe((css) => {
    const q = document.querySelector('#customcss')
    if(q){
        q.textContent = css
    }
    else{
        const s = document.createElement('style')
        s.id = 'customcss'
        s.textContent = css
        document.body.appendChild(s)
    }
})

export function createSimpleCharacter(char:character){
    if(!char){
        return null
    }

    const simpleChar:simpleCharacterArgument = {
        type: "simple",
        name: char.name,
        customscript: char.customscript,
        chaId: char.chaId,
        additionalAssets: char.additionalAssets,
        emotionImages: char.emotionImages,
        triggerscript: char.triggerscript,
        prebuiltAssetStyle: char.prebuiltAssetStyle,
    }

    return simpleChar

}

export const DBState = $state({
    db: {} as any as Database
});

export const LoadingStatusState = $state({
    text: '',
})

export const loadingOverlayStore = writable<{
    active: boolean,
    text: string,
    onCancel?: (() => void) | null,
    owner?: symbol,
}>({
    active: false,
    text: '',
    onCancel: null,
})

/** A late completion must not hide the overlay claimed by a newer operation. */
export function claimLoadingOverlay(text: string, onCancel: (() => void) | null = null): () => void {
    const owner = Symbol('loading-overlay')
    loadingOverlayStore.set({ active: true, text, onCancel, owner })
    return () => {
        if (get(loadingOverlayStore).owner === owner) {
            loadingOverlayStore.set({ active: false, text: '', onCancel: null })
        }
    }
}

export function dismissClaimedLoadingOverlay(): void {
    if (get(loadingOverlayStore).owner !== undefined) {
        loadingOverlayStore.set({ active: false, text: '', onCancel: null })
    }
}

export const QuickSettings = $state({
    open: false,
    index: 0
})

export type MenuDef = {
    name: string,
    pluginName?: string,
    sidebarKey?: string,
    icon: string,
    iconType:'html'|'img'|'none',
    callback: any,
    id: string,
}

export type ChatPanelDef = {
    id: string,
    pluginName: string,
    html: string,
    className?: string,
}

export const additionalSettingsMenu = $state([] as MenuDef[])
export const additionalFloatingActionButtons = $state([] as MenuDef[])
export const additionalHamburgerMenu = $state([] as MenuDef[])
export const additionalChatMenu = $state([] as MenuDef[])
export const chatPanelStore = $state([] as ChatPanelDef[])
export const bodyIntercepterStore = $state([] as {
    id: string,
    callback: (body: any, type: string) => Promise<any>
}[])
export const popupStore = $state({
    children: null as null | import("svelte").Snippet,
    mouseX: 0,
    mouseY: 0,
    openId: 0,
})

export function closePopup() {
    popupStore.children = null
    popupStore.openId = 0
}

export interface PopupEditorMetadata {
    label: string
    value: string
}

export interface PopupEditorOptions {
    value: string
    title?: string
    description?: string
    helpKey?: keyof typeof language.help
    metadata?: PopupEditorMetadata[]
    formatJson?: boolean
    mode?: 'plain' | 'cbs'
    imageTags?: boolean
    commitMode?: PopupEditorCommitMode
    debounceMs?: number
    hideCancel?: boolean
    submitKind?: 'save' | 'send' | 'download'
    /** Writes through the source field's commit path; omit for a read-only viewer. */
    onCommit?: (value: string) => PopupEditorCommitResult | Promise<PopupEditorCommitResult>
    /** Optional action after committing editable content (for example, send or download). */
    onSubmit?: (value: string) => PopupEditorCommitResult | Promise<PopupEditorCommitResult>
}

export const popUpEditorStore = $state({
    open: false,
    value: '',
    originalValue: '',
    title: '',
    description: '',
    helpKey: undefined as PopupEditorOptions['helpKey'],
    metadata: [] as PopupEditorMetadata[],
    formatJson: false,
    mode: 'cbs' as 'plain' | 'cbs',
    imageTags: false,
    commitMode: 'submit' as PopupEditorCommitMode,
    debounceMs: INPUT_COMMIT_DEBOUNCE_MS,
    hideCancel: false,
    submitKind: 'save' as NonNullable<PopupEditorOptions['submitKind']>,
    onCommit: null as null | ((value: string) => PopupEditorCommitResult | Promise<PopupEditorCommitResult>),
    onSubmit: null as null | ((value: string) => PopupEditorCommitResult | Promise<PopupEditorCommitResult>)
})

export function showPopupEditor(options: PopupEditorOptions) {
    popUpEditorStore.value = options.value
    popUpEditorStore.originalValue = options.value
    popUpEditorStore.title = options.title ?? ''
    popUpEditorStore.description = options.description ?? ''
    popUpEditorStore.helpKey = options.helpKey
    popUpEditorStore.metadata = options.metadata ?? []
    popUpEditorStore.formatJson = options.formatJson ?? false
    popUpEditorStore.mode = options.mode ?? 'cbs'
    popUpEditorStore.imageTags = options.imageTags ?? false
    popUpEditorStore.commitMode = options.commitMode ?? 'submit'
    popUpEditorStore.debounceMs = options.debounceMs ?? INPUT_COMMIT_DEBOUNCE_MS
    popUpEditorStore.hideCancel = options.hideCancel ?? false
    popUpEditorStore.submitKind = options.submitKind ?? 'save'
    popUpEditorStore.onCommit = options.onCommit ?? null
    popUpEditorStore.onSubmit = options.onSubmit ?? null
    popUpEditorStore.open = true
}


selectedCharID.subscribe((id) => {
    const char = DBState?.db?.characters?.[id]
    if (char && DBState.db.hypaV3 && DBState.db.hypaV3Presets?.[DBState.db.hypaV3PresetId]?.settings?.alwaysToggleOn) {
        if (char.chats?.[getChatPage(char)]) {
            char.chats[getChatPage(char)].supaMemory = true
        }
    }
})

$effect.root(() => {
    $effect(() => {
        // Nothing to sync before the database loads. Bailing out here also keeps the
        // first flush from reaching modules still initializing in the import cycle.
        if (!DBState.db.characters) return
        try { deepTouch(DBState.db.modules) } catch (e) {
            console.warn('[ModuleUpdate] deepTouch(modules) failed:', e)
            return
        }
        DBState?.db?.enabledModules
        DBState?.db?.enabledModules?.length
        DBState?.db?.personaEnabledModules
        DBState?.db?.showPersonaInSidebar
        DBState?.db?.selectedPersona
        DBState?.db?.characters?.[selIdState.selId]?.chats?.[getChatPage(DBState?.db?.characters?.[selIdState.selId])]?.bindedPersona
        DBState?.db?.characters?.[selIdState.selId]?.chats?.[getChatPage(DBState?.db?.characters?.[selIdState.selId])]?.modules?.length
        DBState?.db?.characters?.[selIdState.selId]?.hideChatIcon
        DBState?.db?.characters?.[selIdState.selId]?.backgroundHTML
        DBState?.db?.moduleIntergration
        moduleUpdate()
    })
})
